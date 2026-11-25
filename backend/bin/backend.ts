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
/** The prefix in GitHub's immutable format, from the variables GitHub Actions sets. */
function actionsSubjectPrefix(): string | undefined {
  const {
    GITHUB_REPOSITORY_OWNER: owner,
    GITHUB_REPOSITORY_OWNER_ID: ownerId,
    GITHUB_REPOSITORY: repository,
    GITHUB_REPOSITORY_ID: repositoryId,
  } = process.env;
  if (!owner || !ownerId || !repository || !repositoryId) return undefined;
  return `repo:${owner}@${ownerId}/${repository.slice(owner.length + 1)}@${repositoryId}`;
}

// Deployed by hand with -c githubSubjectPrefix=<prefix> (see the README). GitHub Actions
// only deploys the stage stacks, but synthesizes this one too.
const subjectPrefix: string | undefined =
  app.node.tryGetContext('githubSubjectPrefix') ?? actionsSubjectPrefix();
if (subjectPrefix) {
  new GitHubOidcStack(app, 'HubWebSocket-GitHubOidc', {
    env,
    subjectPrefix,
    environments: [...stages],
    existingProviderArn: app.node.tryGetContext('githubOidcProviderArn'),
  });
}
