import {
  Effect,
  ManagedPolicy,
  OidcProviderNative,
  OpenIdConnectPrincipal,
  PolicyDocument,
  PolicyStatement,
  Role,
} from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

export interface GitHubOidcStackProps extends cdk.StackProps {
  /**
   * Start of the `sub` claim of the repository's OIDC tokens, before `:environment:<name>`,
   * such as `repo:owner@<owner id>/name@<repo id>` in GitHub's immutable format.
   */
  subjectPrefix: string;
  /** GitHub Environments allowed to assume the deploy role. */
  environments: string[];
  /** ARN of an existing GitHub OIDC provider; an account holds at most one per URL. */
  existingProviderArn?: string;
}

/** Managed policy that caps every role the stage stacks create, including the bootstrap's CloudFormation execution role. */
export const DEPLOY_BOUNDARY_NAME = 'HubWebSocket-DeployBoundary';

/** Services the stage stacks create resources in or call at run time; roles under the boundary get nothing else. */
export const BOUNDARY_SERVICES = [
  'apigateway',
  'cloudfront',
  'cloudwatch',
  'dynamodb',
  'execute-api',
  'iam',
  'kms',
  'lambda',
  'logs',
  's3',
  'scheduler',
  'ssm',
];

const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
const AUDIENCE = 'sts.amazonaws.com';

/**
 * GitHub Actions' access to the account and the limits on what its deploys can do: the role
 * assumed through OIDC to run `cdk deploy`, and the permissions boundary.
 *
 * Deployed by hand with the deployer's own credentials, not the bootstrap roles, so nothing
 * running under the boundary can change it.
 */
export class GitHubOidcStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GitHubOidcStackProps) {
    super(scope, id, { synthesizer: new cdk.CliCredentialsStackSynthesizer(), ...props });

    const provider = props.existingProviderArn
      ? OidcProviderNative.fromOidcProviderArn(this, 'Provider', props.existingProviderArn)
      : new OidcProviderNative(this, 'Provider', { url: GITHUB_OIDC_URL, clientIds: [AUDIENCE] });

    const issuer = GITHUB_OIDC_URL.replace('https://', '');
    const role = new Role(this, 'DeployRole', {
      description: `GitHub Actions deploys from ${props.subjectPrefix}`,
      assumedBy: new OpenIdConnectPrincipal(provider, {
        StringEquals: {
          [`${issuer}:aud`]: AUDIENCE,
          [`${issuer}:sub`]: props.environments.map(
            (env) => `${props.subjectPrefix}:environment:${env}`,
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

    new ManagedPolicy(this, 'DeployBoundary', {
      managedPolicyName: DEPLOY_BOUNDARY_NAME,
      description:
        'Permissions boundary for the roles that CDK deploys create (see GitHubOidcStack)',
      document: this.boundaryDocument(qualifier),
    });

    new cdk.CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
  }

  private boundaryDocument(qualifier: string): PolicyDocument {
    const iamArn = (resource: string, resourceName: string) =>
      cdk.Arn.format({ service: 'iam', region: '', resource, resourceName }, this);
    const boundaryArn = iamArn('policy', DEPLOY_BOUNDARY_NAME);
    const stagingBucket = cdk.Arn.format(
      {
        service: 's3',
        region: '',
        account: '',
        resource: `cdk-${qualifier}-assets-${this.account}-${this.region}`,
      },
      this,
    );
    const bootstrapVersion = cdk.Arn.format(
      { service: 'ssm', resource: 'parameter', resourceName: `cdk-bootstrap/${qualifier}/version` },
      this,
    );
    const deny = (sid: string, actions: string[], resources: string[], conditions?: object) =>
      new PolicyStatement({ sid, effect: Effect.DENY, actions, resources, conditions });

    return new PolicyDocument({
      statements: [
        new PolicyStatement({
          sid: 'AllowProjectServices',
          actions: BOUNDARY_SERVICES.map((service) => `${service}:*`),
          resources: ['*'],
        }),
        // Every role created under the boundary carries it, so none can escape it.
        deny(
          'DenyRolesWithoutBoundary',
          ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'],
          ['*'],
          {
            StringNotEquals: { 'iam:PermissionsBoundary': boundaryArn },
          },
        ),
        deny(
          'DenyBoundaryRemoval',
          ['iam:DeleteRolePermissionsBoundary', 'iam:DeleteUserPermissionsBoundary'],
          ['*'],
        ),
        deny(
          'DenyBoundaryChanges',
          [
            'iam:CreatePolicyVersion',
            'iam:DeletePolicy',
            'iam:DeletePolicyVersion',
            'iam:SetDefaultPolicyVersion',
          ],
          [boundaryArn],
        ),
        // No users, keys or identity providers that would outlive a deploy.
        deny(
          'DenyLongLivedIdentities',
          [
            'iam:CreateUser',
            'iam:CreateAccessKey',
            'iam:CreateLoginProfile',
            'iam:UpdateLoginProfile',
            'iam:CreateServiceSpecificCredential',
            'iam:*OpenIDConnectProvider*',
            'iam:*SAMLProvider*',
          ],
          ['*'],
        ),
        // The deploy path itself: bootstrap roles, this stack's roles, the staging bucket and
        // the bootstrap version. CloudFormation isn't in the allowed services, which already
        // keeps these stacks out of reach.
        deny(
          'DenyDeployPathChanges',
          [
            'iam:Attach*',
            'iam:Create*',
            'iam:Delete*',
            'iam:Detach*',
            'iam:PassRole',
            'iam:Put*',
            'iam:Tag*',
            'iam:Untag*',
            'iam:Update*',
          ],
          [iamArn('role', `cdk-${qualifier}-*`), iamArn('role', `${this.stackName}-*`)],
        ),
        deny(
          'DenyStagingChanges',
          ['s3:Delete*', 's3:Put*'],
          [stagingBucket, `${stagingBucket}/*`],
        ),
        deny(
          'DenyBootstrapVersionChanges',
          ['ssm:Delete*', 'ssm:Put*', 'ssm:Label*'],
          [bootstrapVersion],
        ),
      ],
    });
  }
}
