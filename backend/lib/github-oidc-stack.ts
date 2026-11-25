import {
  OidcProviderNative,
  OpenIdConnectPrincipal,
  PolicyStatement,
  Role,
} from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

export interface GitHubOidcStackProps extends cdk.StackProps {
  /** GitHub repository in `owner/name` form. */
  repository: string;
  /** GitHub Environments allowed to assume the deploy role. */
  environments: string[];
  /** ARN of an existing GitHub OIDC provider; an account holds at most one per URL. */
  existingProviderArn?: string;
}

const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'sts.amazonaws.com';

/** Role assumed by GitHub Actions to run `cdk deploy`, deployed once by hand. */
export class GitHubOidcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GitHubOidcStackProps) {
    super(scope, id, props);

    const provider = props.existingProviderArn
      ? OidcProviderNative.fromOidcProviderArn(this, 'Provider', props.existingProviderArn)
      : new OidcProviderNative(this, 'Provider', { url: GITHUB_OIDC_URL, clientIds: [AUDIENCE] });

    const issuer = GITHUB_OIDC_URL.replace('https://', '');
    const role = new Role(this, 'DeployRole', {
      description: `GitHub Actions deploys from ${props.repository}`,
      assumedBy: new OpenIdConnectPrincipal(provider, {
        StringEquals: {
          [`${issuer}:aud`]: AUDIENCE,
          [`${issuer}:sub`]: props.environments.map(
            (env) => `repo:${props.repository}:environment:${env}`,
          ),
        },
      }),
    });
    // The bootstrap roles do the actual work; this role can only hand off to them.
    // No image-publishing role: the stacks have no Docker assets. The CLI reads the
    // deployed template through the lookup role and falls back to this role's own
    // credentials, which can't read CloudFormation, if it can't assume it.
    const qualifier = cdk.DefaultStackSynthesizer.DEFAULT_QUALIFIER;
    role.addToPolicy(
      new PolicyStatement({
        actions: ['sts:AssumeRole'],
        resources: ['deploy-role', 'file-publishing-role', 'lookup-role'].map((name) =>
          cdk.Arn.format(
            {
              service: 'iam',
              region: '',
              resource: 'role',
              resourceName: `cdk-${qualifier}-${name}-${this.account}-${this.region}`,
            },
            this,
          ),
        ),
      }),
    );

    new cdk.CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
  }
}
