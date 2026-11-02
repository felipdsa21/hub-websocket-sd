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
  for (const RouteKey of ['$connect', '$disconnect', '$default', 'heartbeat']) {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey });
  }
  template.allResourcesProperties('AWS::Lambda::Function', { Timeout: 10 });
});

test('lets the Lambdas post to connections (R04)', () => {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([Match.objectLike({ Action: 'execute-api:ManageConnections' })]),
    },
  });
});
