import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';
import { GitHubOidcStack } from '../lib/github-oidc-stack';

const props = {
  env: { account: '123456789012', region: 'sa-east-1' },
  repository: 'owner/repo',
  environments: ['dev', 'prod'],
};
// As in cdk.json, so the role ARNs come out as plain strings.
const newApp = () => new cdk.App({ context: { '@aws-cdk/core:enablePartitionLiterals': true } });

test('trusts only the repository environments and can only assume the CDK bootstrap roles it needs', () => {
  const template = Template.fromStack(new GitHubOidcStack(newApp(), 'Test', props));

  template.hasResourceProperties('AWS::IAM::OIDCProvider', {
    Url: 'https://token.actions.githubusercontent.com',
    ClientIdList: ['sts.amazonaws.com'],
  });
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: [
        Match.objectLike({
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub': [
                'repo:owner/repo:environment:dev',
                'repo:owner/repo:environment:prod',
              ],
            },
          },
        }),
      ],
    },
  });
  template.resourceCountIs('AWS::IAM::Policy', 1);
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: [
        {
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Resource: ['deploy-role', 'file-publishing-role', 'lookup-role'].map(
            (name) => `arn:aws:iam::123456789012:role/cdk-hnb659fds-${name}-123456789012-sa-east-1`,
          ),
        },
      ],
    },
  });
});

test('imports an existing OIDC provider instead of creating one', () => {
  const arn = 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com';
  const template = Template.fromStack(
    new GitHubOidcStack(newApp(), 'Test', { ...props, existingProviderArn: arn }),
  );

  template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: [Match.objectLike({ Principal: { Federated: arn } })],
    },
  });
});
