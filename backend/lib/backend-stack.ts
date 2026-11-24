import { CfnStage, WebSocketApi, WebSocketStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import {
  CachePolicy,
  Distribution,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import {
  Alarm,
  ComparisonOperator,
  Dashboard,
  GraphWidget,
  MathExpression,
  Metric,
  Stats,
  TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { AttributeType, BillingMode, Operation, Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Schedule, ScheduleExpression } from 'aws-cdk-lib/aws-scheduler';
import { LambdaInvoke } from 'aws-cdk-lib/aws-scheduler-targets';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BackendStackProps extends cdk.StackProps {
  stage: 'dev' | 'prod';
  /** Path to the built Angular browser bundle; if present, deployed to S3 alongside config.json. */
  frontendDistPath?: string;
}

// Application routes served by the app Lambda (architecture, section 4.1).
const APP_ROUTES = [
  'heartbeat',
  'sync',
  'sendMessage',
  'openDirect',
  'createGroup',
  'addMember',
  'leaveGroup',
  'getHistory',
  'search',
];

export class BackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);

    const isProd = props.stage === 'prod';
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    const table = (name: string, partitionKey: string, sortKey?: string, ttl?: string) =>
      new Table(this, name, {
        partitionKey: { name: partitionKey, type: AttributeType.STRING },
        sortKey: sortKey ? { name: sortKey, type: AttributeType.STRING } : undefined,
        timeToLiveAttribute: ttl,
        billingMode: BillingMode.PAY_PER_REQUEST,
        pointInTimeRecoverySpecification: isProd ? { pointInTimeRecoveryEnabled: true } : undefined,
        removalPolicy,
      });
    const tables = {
      CONNECTIONS_TABLE: table('Connections', 'connectionId', undefined, 'expiresAt'),
      USERS_TABLE: table('Users', 'username'),
      CONVERSATIONS_TABLE: table('Conversations', 'conversationId'),
      MEMBERSHIPS_TABLE: table('Memberships', 'username', 'conversationId'),
      MESSAGES_TABLE: table('Messages', 'conversationId', 'sk', 'expiresAt'),
    };
    type TableKey = keyof typeof tables;

    const fn = (
      name: string,
      opts: {
        memorySize: number;
        timeoutSeconds?: number;
        readWrite: TableKey[];
        read?: TableKey[];
      },
    ) => {
      const read = opts.read ?? [];
      const tableKeys = [...opts.readWrite, ...read];
      const logGroup = new LogGroup(this, `${name}Logs`, {
        retention: isProd ? RetentionDays.ONE_MONTH : RetentionDays.TWO_WEEKS,
        removalPolicy,
      });
      const f = new NodejsFunction(this, name, {
        entry: path.join(__dirname, '..', 'functions', `${name}.ts`),
        runtime: Runtime.NODEJS_24_X,
        architecture: Architecture.ARM_64,
        memorySize: opts.memorySize,
        timeout: cdk.Duration.seconds(opts.timeoutSeconds ?? 10),
        logGroup,
        environment: Object.fromEntries(tableKeys.map((key) => [key, tables[key].tableName])),
      });
      opts.readWrite.forEach((key) => tables[key].grantReadWriteData(f));
      read.forEach((key) => tables[key].grantReadData(f));
      return f;
    };
    const presenceTables = {
      readWrite: ['CONNECTIONS_TABLE', 'USERS_TABLE'] as TableKey[],
      read: ['MEMBERSHIPS_TABLE', 'CONVERSATIONS_TABLE'] as TableKey[],
    };
    const connect = fn('connect', { memorySize: 512, ...presenceTables });
    const disconnect = fn('disconnect', { memorySize: 512, ...presenceTables });
    const fallback = fn('default', { memorySize: 512, ...presenceTables });
    const app = fn('app', {
      memorySize: 512,
      readWrite: [
        'CONNECTIONS_TABLE',
        'USERS_TABLE',
        'CONVERSATIONS_TABLE',
        'MEMBERSHIPS_TABLE',
        'MESSAGES_TABLE',
      ],
    });
    // Single pass of Connections + Users + OpenConnections metric fits well within 30 s.
    const sweeper = fn('presenceSweeper', {
      memorySize: 256,
      timeoutSeconds: 30,
      ...presenceTables,
    });

    // SecureString parameter created once per stage outside CDK (architecture, section 5).
    const hmacParamName = `/hub-websocket/${props.stage}/log-hmac-secret`;
    const hmacParamArn = cdk.Arn.format(
      { service: 'ssm', resource: 'parameter', resourceName: hmacParamName.slice(1) },
      this,
    );
    const ssmReadPolicy = new PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [hmacParamArn],
    });
    // Decrypting an SSM SecureString encrypted with the AWS-managed key requires kms:Decrypt on aws/ssm.
    const kmsDecryptPolicy = new PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: [cdk.Arn.format({ service: 'kms', resource: 'key', resourceName: '*' }, this)],
      conditions: {
        StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` },
        'ForAnyValue:StringEquals': { 'kms:ResourceAliases': 'alias/aws/ssm' },
      },
    });
    for (const f of [connect, disconnect, fallback, app]) {
      f.addEnvironment('LOG_HMAC_SECRET_PARAM', hmacParamName);
      f.addToRolePolicy(ssmReadPolicy);
      f.addToRolePolicy(kmsDecryptPolicy);
    }

    const metricsNamespace = `HubWebSocket/${props.stage}`;
    sweeper.addEnvironment('METRICS_NAMESPACE', metricsNamespace);
    sweeper.addToRolePolicy(
      new PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': metricsNamespace } },
      }),
    );

    // No retries and the shortest event age: the next run, a minute later, redoes the same work (D05).
    sweeper.configureAsyncInvoke({ retryAttempts: 0, maxEventAge: cdk.Duration.seconds(60) });
    new Schedule(this, 'PresenceSweeperSchedule', {
      schedule: ScheduleExpression.rate(cdk.Duration.minutes(1)),
      target: new LambdaInvoke(sweeper, {
        retryAttempts: 0,
        maxEventAge: cdk.Duration.seconds(60),
      }),
    });

    const api = new WebSocketApi(this, 'Api', {
      routeSelectionExpression: '$request.body.action',
      connectRouteOptions: {
        integration: new WebSocketLambdaIntegration('ConnectIntegration', connect),
      },
      disconnectRouteOptions: {
        integration: new WebSocketLambdaIntegration('DisconnectIntegration', disconnect),
      },
      defaultRouteOptions: {
        integration: new WebSocketLambdaIntegration('DefaultIntegration', fallback),
      },
    });
    const appIntegration = new WebSocketLambdaIntegration('AppIntegration', app);
    APP_ROUTES.forEach((route) => api.addRoute(route, { integration: appIntegration }));

    const stage = new WebSocketStage(this, 'Stage', {
      webSocketApi: api,
      stageName: props.stage,
      autoDeploy: true,
    });
    const cfnStage = stage.node.defaultChild as CfnStage;
    cfnStage.defaultRouteSettings = {
      throttlingRateLimit: 1000,
      throttlingBurstLimit: 2000,
    };
    for (const f of [connect, disconnect, fallback, app, sweeper]) {
      f.addEnvironment('CALLBACK_URL', stage.callbackUrl);
      stage.grantManagementApiAccess(f);
    }

    const period = cdk.Duration.minutes(1);
    const apiMetric = (metricName: string, statistic: string, label: string) =>
      new Metric({
        namespace: 'AWS/ApiGateway',
        metricName,
        dimensionsMap: { ApiId: api.apiId, Stage: props.stage },
        statistic,
        label,
        period,
      });

    // CloudWatch dashboard with API Gateway, Lambda, DynamoDB and open-connections metrics (RNF06, section 5).
    const dashboard = new Dashboard(this, 'Dashboard', {
      dashboardName: `HubWebSocket-${props.stage}`,
    });
    dashboard.addWidgets(
      new GraphWidget({
        title: 'Conexões',
        width: 12,
        left: [
          apiMetric('ConnectCount', Stats.SUM, 'ConnectCount'),
          new Metric({
            namespace: metricsNamespace,
            metricName: 'OpenConnections',
            statistic: Stats.MAXIMUM,
            label: 'OpenConnections',
            period,
          }),
        ],
      }),
      new GraphWidget({
        title: 'Mensagens e requisições',
        width: 12,
        left: [
          apiMetric('MessageCount', Stats.SUM, 'API Gateway MessageCount'),
          app.metricInvocations({ period, label: 'Lambda app' }),
          fallback.metricInvocations({ period, label: 'Lambda default' }),
          connect.metricInvocations({ period, label: 'Lambda connect' }),
          disconnect.metricInvocations({ period, label: 'Lambda disconnect' }),
        ],
      }),
    );
    dashboard.addWidgets(
      new GraphWidget({
        title: 'Erros',
        width: 12,
        left: [
          apiMetric('IntegrationError', Stats.SUM, 'IntegrationError'),
          apiMetric('ClientError', Stats.SUM, 'ClientError'),
          apiMetric('ExecutionError', Stats.SUM, 'ExecutionError'),
          connect.metricErrors({ period, label: 'connect errors' }),
          disconnect.metricErrors({ period, label: 'disconnect errors' }),
          fallback.metricErrors({ period, label: 'default errors' }),
          app.metricErrors({ period, label: 'app errors' }),
          sweeper.metricErrors({ period, label: 'presenceSweeper errors' }),
        ],
      }),
      new GraphWidget({
        title: 'Latência (ms)',
        width: 12,
        left: [
          apiMetric('IntegrationLatency', Stats.AVERAGE, 'IntegrationLatency (avg)'),
          apiMetric('IntegrationLatency', 'p95', 'IntegrationLatency (p95)'),
          app.metricDuration({ period, statistic: Stats.AVERAGE, label: 'Lambda app (avg)' }),
          app.metricDuration({ period, statistic: 'p95', label: 'Lambda app (p95)' }),
          connect.metricDuration({
            period,
            statistic: Stats.AVERAGE,
            label: 'Lambda connect (avg)',
          }),
          connect.metricDuration({ period, statistic: 'p95', label: 'Lambda connect (p95)' }),
          sweeper.metricDuration({
            period,
            statistic: Stats.AVERAGE,
            label: 'Lambda presenceSweeper (avg)',
          }),
          sweeper.metricDuration({
            period,
            statistic: Stats.MAXIMUM,
            label: 'Lambda presenceSweeper (max)',
          }),
        ],
      }),
    );
    const dynamoOps = [
      Operation.GET_ITEM,
      Operation.BATCH_GET_ITEM,
      Operation.PUT_ITEM,
      Operation.UPDATE_ITEM,
      Operation.DELETE_ITEM,
      Operation.QUERY,
      Operation.SCAN,
      Operation.TRANSACT_WRITE_ITEMS,
    ];
    // DynamoDB publishes SystemErrors and ThrottledRequests per (TableName, Operation); unique metric IDs avoid CDK GraphWidget collisions.
    const dynamoMetric = (
      idPrefix: string,
      t: Table,
      metricName: 'SystemErrors' | 'ThrottledRequests',
      label: string,
    ) => {
      const usingMetrics = Object.fromEntries(
        dynamoOps.map((op, idx) => [
          `${idPrefix}_${idx}`,
          new Metric({
            namespace: 'AWS/DynamoDB',
            metricName,
            dimensionsMap: { TableName: t.tableName, Operation: op },
            statistic: Stats.SUM,
            period,
          }),
        ]),
      );
      return new MathExpression({
        expression: `SUM([${Object.keys(usingMetrics).join(', ')}])`,
        usingMetrics,
        label,
        period,
      });
    };
    const tableMetrics = [
      ['Connections', tables.CONNECTIONS_TABLE],
      ['Users', tables.USERS_TABLE],
      ['Conversations', tables.CONVERSATIONS_TABLE],
      ['Memberships', tables.MEMBERSHIPS_TABLE],
      ['Messages', tables.MESSAGES_TABLE],
    ] as const;
    dashboard.addWidgets(
      new GraphWidget({
        title: 'Throttles (Lambda)',
        width: 12,
        left: [
          connect.metricThrottles({ period, label: 'connect throttles' }),
          disconnect.metricThrottles({ period, label: 'disconnect throttles' }),
          fallback.metricThrottles({ period, label: 'default throttles' }),
          app.metricThrottles({ period, label: 'app throttles' }),
          sweeper.metricThrottles({ period, label: 'presenceSweeper throttles' }),
        ],
      }),
      new GraphWidget({
        title: 'DynamoDB (erros e throttling)',
        width: 12,
        left: tableMetrics.flatMap(([label, t], i) => [
          dynamoMetric(`se_${i}`, t, 'SystemErrors', `${label} SystemErrors`),
          dynamoMetric(`tr_${i}`, t, 'ThrottledRequests', `${label} ThrottledRequests`),
        ]),
      }),
    );

    new Alarm(this, 'AppErrorsAlarm', {
      alarmName: `HubWebSocket-${props.stage}-AppErrors`,
      alarmDescription: 'Lambda app reported one or more invocation errors.',
      metric: app.metricErrors({ period, statistic: Stats.SUM }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    new Alarm(this, 'AppThrottlesAlarm', {
      alarmName: `HubWebSocket-${props.stage}-AppThrottles`,
      alarmDescription: 'Lambda app had one or more throttled invocations.',
      metric: app.metricThrottles({ period, statistic: Stats.SUM }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    new Alarm(this, 'PresenceSweeperDurationAlarm', {
      alarmName: `HubWebSocket-${props.stage}-PresenceSweeperDuration`,
      alarmDescription: 'Lambda presenceSweeper duration approached its 30 s timeout.',
      metric: sweeper.metricDuration({ period, statistic: Stats.MAXIMUM }),
      threshold: 20_000,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    // Static frontend hosted in a private S3 bucket behind CloudFront with OAC (D08, RNF07).
    const frontendBucket = new Bucket(this, 'FrontendBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: isProd,
      removalPolicy,
      autoDeleteObjects: !isProd,
    });
    const responseHeadersPolicy = new ResponseHeadersPolicy(this, 'FrontendSecurityHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        contentSecurityPolicy: {
          override: true,
          contentSecurityPolicy:
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' wss: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        },
      },
    });
    const frontendOrigin = S3BucketOrigin.withOriginAccessControl(frontendBucket);
    const distribution = new Distribution(this, 'FrontendDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: frontendOrigin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy,
      },
      additionalBehaviors: {
        'config.json': {
          origin: frontendOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy,
        },
        'index.html': {
          origin: frontendOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy,
        },
      },
      // SPA fallback so deep links like /entrar or /c/<id> serve index.html.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    const frontendDistPath =
      props.frontendDistPath ??
      path.join(__dirname, '..', '..', 'frontend', 'dist', 'hub-websocket-sd-frontend', 'browser');
    const hasFrontendDist = fs.existsSync(frontendDistPath);
    new BucketDeployment(this, 'FrontendDeployment', {
      sources: [
        ...(hasFrontendDist ? [Source.asset(frontendDistPath)] : []),
        Source.jsonData('config.json', { websocketUrl: stage.url }),
      ],
      destinationBucket: frontendBucket,
      distribution,
      distributionPaths: ['/*'],
      // Keep existing static assets in S3 when deploying backend changes without a local frontend build.
      prune: hasFrontendDist,
    });

    new cdk.CfnOutput(this, 'WebSocketUrl', { value: stage.url });
    new cdk.CfnOutput(this, 'FrontendUrl', {
      value: `https://${distribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, 'FrontendBucketName', { value: frontendBucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'DashboardName', { value: dashboard.dashboardName });
    new cdk.CfnOutput(this, 'LogHmacSecretParam', { value: hmacParamName });
  }
}
