import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BackendStack } from '../lib/backend-stack';

const template = Template.fromStack(
  new BackendStack(new cdk.App(), 'Test', {
    stage: 'dev',
    // Avoid depending on whether frontend/dist has been built locally when running backend unit tests.
    frontendDistPath: '__nonexistent_for_unit_test__',
  }),
);

test('creates the five on-demand tables, with TTL only on Connections', () => {
  template.resourceCountIs('AWS::DynamoDB::Table', 5);
  template.allResourcesProperties('AWS::DynamoDB::Table', { BillingMode: 'PAY_PER_REQUEST' });
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [{ AttributeName: 'connectionId', KeyType: 'HASH' }],
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

test('runs the presence sweeper every minute without retries (D05)', () => {
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
  template.hasResourceProperties('AWS::Lambda::Function', { Timeout: 50 });
  template.resourcePropertiesCountIs('AWS::Lambda::Function', { Timeout: 10 }, 4);
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

test('creates the CloudWatch dashboard with all 4 widgets and allows sweeper to publish OpenConnections (RNF06)', () => {
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
    'p95',
  ]) {
    expect(bodyStr).toContain(expected);
  }
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

test('hosts the static frontend in a private S3 bucket behind CloudFront with OAC (D08, RNF07)', () => {
  template.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Delete',
    Properties: {
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
  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      DefaultRootObject: 'index.html',
      DefaultCacheBehavior: Match.objectLike({
        ViewerProtocolPolicy: 'redirect-to-https',
      }),
      CacheBehaviors: Match.arrayWith([
        Match.objectLike({
          PathPattern: 'config.json',
          ViewerProtocolPolicy: 'redirect-to-https',
          // Managed CachingDisabled policy ID.
          CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
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
  const deployments = template.findResources('Custom::CDKBucketDeployment');
  const markersStr = JSON.stringify(Object.values(deployments)[0]!.Properties.SourceMarkers);
  expect(markersStr).toContain('wss://');
  expect(markersStr).toContain('/dev');
  template.hasOutput('FrontendUrl', {});
  template.hasOutput('FrontendBucketName', {});
  template.hasOutput('DistributionId', {});
});

test('prunes stale assets only when frontendDistPath exists and retains frontend bucket in prod', () => {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-frontend-dist-'));
  try {
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>');
    const prodTemplate = Template.fromStack(
      new BackendStack(new cdk.App(), 'ProdTest', {
        stage: 'prod',
        frontendDistPath: distDir,
      }),
    );
    prodTemplate.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
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
