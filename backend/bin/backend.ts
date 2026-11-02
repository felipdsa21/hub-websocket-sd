#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { BackendStack } from '../lib/backend-stack';

const app = new cdk.App();
// One stack per stage, each with its own API, Lambdas and tables, in São Paulo (D07).
for (const stage of ['dev', 'prod'] as const) {
  new BackendStack(app, `HubWebSocket-${stage}`, {
    stage,
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'sa-east-1' },
  });
}
