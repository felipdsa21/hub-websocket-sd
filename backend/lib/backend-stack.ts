import { WebSocketApi, WebSocketStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AttributeType, BillingMode, Table } from 'aws-cdk-lib/aws-dynamodb';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Schedule, ScheduleExpression } from 'aws-cdk-lib/aws-scheduler';
import { LambdaInvoke } from 'aws-cdk-lib/aws-scheduler-targets';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as path from 'node:path';

export interface BackendStackProps extends cdk.StackProps {
  stage: 'dev' | 'prod';
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

    new cdk.CfnOutput(this, 'WebSocketUrl', { value: stage.url });
  }
}
