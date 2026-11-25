#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { BackendStack } from '../lib/backend-stack';
import { GitHubOidcStack } from '../lib/github-oidc-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'sa-east-1' };
// One stack per stage, each with its own API, Lambdas and tables, in São Paulo (D07).
const stages = ['dev', 'prod'] as const;
for (const stage of stages) {
  new BackendStack(app, `HubWebSocket-${stage}`, { stage, env });
}
// Deployed by hand with -c githubRepository=<owner/name>; GitHub Actions only deploys the
// stage stacks, but synthesizes this one too since it sets GITHUB_REPOSITORY.
const repository: string | undefined =
  app.node.tryGetContext('githubRepository') ?? process.env.GITHUB_REPOSITORY;
if (repository) {
  new GitHubOidcStack(app, 'HubWebSocket-GitHubOidc', {
    env,
    repository,
    environments: [...stages],
    existingProviderArn: app.node.tryGetContext('githubOidcProviderArn'),
  });
}
