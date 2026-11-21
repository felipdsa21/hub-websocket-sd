import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';
import { BackendStack } from '../lib/backend-stack';

const template = Template.fromStack(new BackendStack(new cdk.App(), 'Test', { stage: 'dev' }));

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
