import { WebSocketApi, WebSocketStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { CachePolicy, Distribution, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Dashboard, GraphWidget, Metric, Stats } from 'aws-cdk-lib/aws-cloudwatch';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
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

    const removalPolicy =
      props.stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    const table = (name: string, partitionKey: string, sortKey?: string, ttl?: string) =>
      new Table(this, name, {
        partitionKey: { name: partitionKey, type: AttributeType.STRING },
        sortKey: sortKey ? { name: sortKey, type: AttributeType.STRING } : undefined,
        timeToLiveAttribute: ttl,
        billingMode: BillingMode.PAY_PER_REQUEST,
        removalPolicy,
      });
    const tables = {
      CONNECTIONS_TABLE: table('Connections', 'connectionId', undefined, 'expiresAt'),
      USERS_TABLE: table('Users', 'username'),
      CONVERSATIONS_TABLE: table('Conversations', 'conversationId'),
      MEMBERSHIPS_TABLE: table('Memberships', 'username', 'conversationId'),
      MESSAGES_TABLE: table('Messages', 'conversationId', 'sk'),
    };

    const fn = (name: string, timeoutSeconds = 10) => {
      const f = new NodejsFunction(this, name, {
        entry: path.join(__dirname, '..', 'functions', `${name}.ts`),
        runtime: Runtime.NODEJS_22_X,
        timeout: cdk.Duration.seconds(timeoutSeconds),
        environment: Object.fromEntries(
          Object.entries(tables).map(([key, t]) => [key, t.tableName]),
        ),
      });
      Object.values(tables).forEach((t) => t.grantReadWriteData(f));
      return f;
    };
    const connect = fn('connect');
    const disconnect = fn('disconnect');
    const fallback = fn('default');
    const app = fn('app');
    // Two scans of Connections 30 s apart plus the Users scan fit in 50 s (architecture, section 3.4).
    const sweeper = fn('presenceSweeper', 50);

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

    // CloudWatch dashboard with API Gateway, Lambda and open-connections metrics (RNF06, section 5).
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
        ],
      }),
    );

    // Static frontend hosted in a private S3 bucket behind CloudFront with OAC (D08, RNF07).
    const frontendBucket = new Bucket(this, 'FrontendBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: props.stage !== 'prod',
    });
    const frontendOrigin = S3BucketOrigin.withOriginAccessControl(frontendBucket);
    const distribution = new Distribution(this, 'FrontendDistribution', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: frontendOrigin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        'config.json': {
          origin: frontendOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: CachePolicy.CACHING_DISABLED,
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
    const frontendSources = [
      ...(fs.existsSync(frontendDistPath) ? [Source.asset(frontendDistPath)] : []),
      Source.jsonData('config.json', { websocketUrl: stage.url }),
    ];
    new BucketDeployment(this, 'FrontendDeployment', {
      sources: frontendSources,
      destinationBucket: frontendBucket,
      distribution,
      distributionPaths: ['/*'],
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
