import { WebSocketApi, WebSocketStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as path from 'node:path';

export interface BackendStackProps extends cdk.StackProps {
  stage: 'dev' | 'prod';
}

// Application routes served by the app Lambda; the others fall into $default until implemented.
const APP_ROUTES = ['heartbeat'];

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

    const fn = (name: string) => {
      const f = new NodejsFunction(this, name, {
        entry: path.join(__dirname, '..', 'functions', `${name}.ts`),
        runtime: Runtime.NODEJS_22_X,
        timeout: cdk.Duration.seconds(10),
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
    for (const f of [connect, disconnect, fallback, app]) {
      f.addEnvironment('CALLBACK_URL', stage.callbackUrl);
      stage.grantManagementApiAccess(f);
    }

    new cdk.CfnOutput(this, 'WebSocketUrl', { value: stage.url });
  }
}
