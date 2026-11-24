import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BackendStack } from '../lib/backend-stack';

const app = new cdk.App();
const template = Template.fromStack(
  new BackendStack(app, 'Test', {
    stage: 'dev',
    // Avoid depending on whether frontend/dist has been built locally when running backend unit tests.
    frontendDistPath: '__nonexistent_for_unit_test__',
  }),
);

test('creates the five on-demand tables, with TTL on Connections and Messages and PITR only in prod (M7)', () => {
  template.resourceCountIs('AWS::DynamoDB::Table', 5);
  template.allResourcesProperties('AWS::DynamoDB::Table', {
    BillingMode: 'PAY_PER_REQUEST',
    PointInTimeRecoverySpecification: Match.absent(),
  });
  template.resourcePropertiesCountIs(
    'AWS::DynamoDB::Table',
    { TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true } },
    2,
  );
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [{ AttributeName: 'connectionId', KeyType: 'HASH' }],
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
  });
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [
      { AttributeName: 'conversationId', KeyType: 'HASH' },
      { AttributeName: 'sk', KeyType: 'RANGE' },
    ],
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
  });
});

test('routes by action to the four Lambdas', () => {
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    ProtocolType: 'WEBSOCKET',
    RouteSelectionExpression: '$request.body.action',
  });
  for (const RouteKey of [
    '$connect',
    '$disconnect',
    '$default',
    'heartbeat',
    'sync',
    'sendMessage',
    'openDirect',
    'createGroup',
    'addMember',
    'leaveGroup',
    'getHistory',
    'search',
  ]) {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey });
  }
});

test('configures ARM64, memory, timeout, log retention and sweeper schedule (A2, D05, B10)', () => {
  template.hasResourceProperties('AWS::Scheduler::Schedule', {
    ScheduleExpression: 'rate(1 minute)',
    Target: Match.objectLike({
      RetryPolicy: { MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 60 },
    }),
  });
  template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
    MaximumRetryAttempts: 0,
    MaximumEventAgeInSeconds: 60,
  });
  template.resourcePropertiesCountIs(
    'AWS::Lambda::Function',
    { Timeout: 30, MemorySize: 256, Architectures: ['arm64'] },
    1,
  );
  template.resourcePropertiesCountIs(
    'AWS::Lambda::Function',
    { Timeout: 10, MemorySize: 512, Architectures: ['arm64'] },
    4,
  );
  template.resourceCountIs('AWS::Logs::LogGroup', 5);
  template.allResources('AWS::Logs::LogGroup', {
    DeletionPolicy: 'Delete',
    Properties: {
      RetentionInDays: 14,
      LogGroupName: Match.absent(),
    },
  });
});

test('configures WebSocketStage throttling without accessLogSettings (M6)', () => {
  template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
    StageName: 'dev',
    DefaultRouteSettings: {
      ThrottlingRateLimit: 1000,
      ThrottlingBurstLimit: 2000,
    },
    AccessLogSettings: Match.absent(),
  });
});

test('grants least-privilege DynamoDB permissions per Lambda (M5)', () => {
  const functions = template.findResources('AWS::Lambda::Function');
  const policies = template.findResources('AWS::IAM::Policy');

  const statementsFor = (prefix: string) => {
    const fnEntry = Object.entries(functions).find(([id]) => id.startsWith(prefix));
    expect(fnEntry).toBeDefined();
    const roleId = fnEntry![1].Properties.Role['Fn::GetAtt'][0] as string;
    const policy = Object.values(policies).find((p) =>
      (p.Properties.Roles as { Ref?: string }[])?.some((r) => r.Ref === roleId),
    );
    expect(policy).toBeDefined();
    return policy!.Properties.PolicyDocument.Statement as {
      Action: string | string[];
      Resource: unknown;
    }[];
  };

  const tableAccess = (prefix: string) => {
    const rw = new Set<string>();
    const read = new Set<string>();
    for (const stmt of statementsFor(prefix)) {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      if (!actions.some((a) => a.startsWith('dynamodb:'))) continue;
      const isWrite = actions.some((a) =>
        ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'].includes(a),
      );
      const serialized = JSON.stringify(stmt.Resource);
      for (const name of ['Connections', 'Users', 'Conversations', 'Memberships', 'Messages']) {
        if (serialized.includes(name)) {
          if (isWrite) rw.add(name);
          else read.add(name);
        }
      }
    }
    return {
      rw: [...rw].sort(),
      ro: [...read].filter((name) => !rw.has(name)).sort(),
    };
  };

  for (const name of ['connect', 'disconnect', 'default', 'presenceSweeper']) {
    expect(tableAccess(name)).toEqual({
      rw: ['Connections', 'Users'],
      ro: ['Conversations', 'Memberships'],
    });
  }
  expect(tableAccess('app')).toEqual({
    rw: ['Connections', 'Conversations', 'Memberships', 'Messages', 'Users'],
    ro: [],
  });
});

test('lets the Lambdas post to connections (R04)', () => {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([Match.objectLike({ Action: 'execute-api:ManageConnections' })]),
    },
  });
});

test('grants SSM and KMS decrypt permissions for HMAC log anonymization (RNF03)', () => {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({ Action: 'ssm:GetParameter' }),
        Match.objectLike({
          Action: 'kms:Decrypt',
          Condition: Match.objectLike({
            'ForAnyValue:StringEquals': { 'kms:ResourceAliases': 'alias/aws/ssm' },
          }),
        }),
      ]),
    },
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Environment: {
      Variables: Match.objectLike({
        LOG_HMAC_SECRET_PARAM: '/hub-websocket/dev/log-hmac-secret',
      }),
    },
  });
});

test('creates the CloudWatch dashboard, alarms and allows sweeper to publish OpenConnections (RNF06, B10)', () => {
  template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
    DashboardName: 'HubWebSocket-dev',
  });
  const dashboards = template.findResources('AWS::CloudWatch::Dashboard');
  const bodyStr = JSON.stringify(Object.values(dashboards)[0]!.Properties.DashboardBody);
  for (const expected of [
    'Conexões',
    'ConnectCount',
    'OpenConnections',
    'HubWebSocket/dev',
    'Mensagens e requisições',
    'MessageCount',
    'Erros',
    'IntegrationError',
    'ClientError',
    'ExecutionError',
    'Latência (ms)',
    'IntegrationLatency',
    'Lambda connect (avg)',
    'Lambda presenceSweeper (avg)',
    'p95',
    'Throttles (Lambda)',
    'Throttles',
    'DynamoDB (erros e throttling)',
    'SystemErrors',
    'ThrottledRequests',
  ]) {
    expect(bodyStr).toContain(expected);
  }
  template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'HubWebSocket-dev-AppErrors',
    MetricName: 'Errors',
    Threshold: 1,
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'HubWebSocket-dev-AppThrottles',
    MetricName: 'Throttles',
    Threshold: 1,
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
  });
  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: 'HubWebSocket-dev-PresenceSweeperDuration',
    MetricName: 'Duration',
    Threshold: 20000,
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
  });
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'cloudwatch:PutMetricData',
          Condition: { StringEquals: { 'cloudwatch:namespace': 'HubWebSocket/dev' } },
        }),
      ]),
    },
  });
});

test('hosts the static frontend in a private S3 bucket behind CloudFront with OAC and security headers (A3, D08, RNF07, B10)', () => {
  template.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Delete',
    Properties: {
      VersioningConfiguration: Match.absent(),
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    },
  });
  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: 'Deny',
          Action: 's3:*',
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        }),
        Match.objectLike({
          Effect: 'Allow',
          Action: 's3:GetObject',
          Principal: { Service: 'cloudfront.amazonaws.com' },
          Condition: { StringEquals: { 'AWS:SourceArn': Match.anyValue() } },
        }),
      ]),
    },
  });
  template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
    OriginAccessControlConfig: Match.objectLike({
      OriginAccessControlOriginType: 's3',
      SigningBehavior: 'always',
      SigningProtocol: 'sigv4',
    }),
  });
  template.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
    ResponseHeadersPolicyConfig: Match.objectLike({
      SecurityHeadersConfig: {
        StrictTransportSecurity: {
          AccessControlMaxAgeSec: 31536000,
          IncludeSubdomains: true,
          Override: true,
        },
        ContentTypeOptions: { Override: true },
        FrameOptions: { FrameOption: 'DENY', Override: true },
        ReferrerPolicy: {
          ReferrerPolicy: 'strict-origin-when-cross-origin',
          Override: true,
        },
        ContentSecurityPolicy: {
          Override: true,
          ContentSecurityPolicy:
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' wss: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
        },
      },
    }),
  });
  const securityHeadersRef = { Ref: Match.stringLikeRegexp('^FrontendSecurityHeaders') };
  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      DefaultRootObject: 'index.html',
      DefaultCacheBehavior: Match.objectLike({
        ViewerProtocolPolicy: 'redirect-to-https',
        ResponseHeadersPolicyId: securityHeadersRef,
      }),
      CacheBehaviors: Match.arrayWith([
        Match.objectLike({
          PathPattern: 'config.json',
          ViewerProtocolPolicy: 'redirect-to-https',
          // Managed CachingDisabled policy ID.
          CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
          ResponseHeadersPolicyId: securityHeadersRef,
        }),
        Match.objectLike({
          PathPattern: 'index.html',
          ViewerProtocolPolicy: 'redirect-to-https',
          CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
          ResponseHeadersPolicyId: securityHeadersRef,
        }),
      ]),
      CustomErrorResponses: Match.arrayWith([
        Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }),
        Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
      ]),
    }),
  });
  template.hasResourceProperties('Custom::CDKBucketDeployment', {
    Prune: false,
    DistributionPaths: ['/*'],
  });
  // config.json is a staged asset whose tokens become markers resolved at deploy time.
  const deployment = Object.values(template.findResources('Custom::CDKBucketDeployment'))[0]!;
  const markers: Record<string, { Ref: string }> = deployment.Properties.SourceMarkers[0];
  const configDir = fs
    .readdirSync(app.outdir)
    .find((dir) => fs.existsSync(path.join(app.outdir, dir, 'config.json')))!;
  let config = fs.readFileSync(path.join(app.outdir, configDir, 'config.json'), 'utf8');
  for (const [marker, { Ref }] of Object.entries(markers)) {
    config = config.replaceAll(marker, `\${${Ref}}`);
  }
  const apiId = Object.keys(template.findResources('AWS::ApiGatewayV2::Api'))[0]!;
  expect(JSON.parse(config)).toEqual({
    websocketUrl: `wss://\${${apiId}}.execute-api.\${AWS::Region}.\${AWS::URLSuffix}/dev`,
  });
  template.hasOutput('FrontendUrl', {});
  template.hasOutput('FrontendBucketName', {});
  template.hasOutput('DistributionId', {});
});

test('enables prod hardening: PITR, S3 versioning, 30-day log retention and asset pruning (M7, B10)', () => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-frontend-dist-'));
  try {
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>');
    const prodTemplate = Template.fromStack(
      new BackendStack(new cdk.App(), 'ProdTest', {
        stage: 'prod',
        frontendDistPath: distDir,
      }),
    );
    prodTemplate.allResourcesProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
    prodTemplate.allResources('AWS::Logs::LogGroup', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        RetentionInDays: 30,
        LogGroupName: Match.absent(),
      },
    });
    prodTemplate.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        VersioningConfiguration: { Status: 'Enabled' },
      },
    });
    prodTemplate.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
    prodTemplate.hasResourceProperties('Custom::CDKBucketDeployment', {
      Prune: true,
      DistributionPaths: ['/*'],
    });
  } finally {
    fs.rmSync(distDir, { recursive: true, force: true });
  }
});
