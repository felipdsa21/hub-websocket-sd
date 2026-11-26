import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cdk from 'aws-cdk-lib/core';
import { BackendStack } from '../lib/backend-stack';
import { BOUNDARY_SERVICES, DEPLOY_BOUNDARY_NAME, GitHubOidcStack } from '../lib/github-oidc-stack';

const props = {
  env: { account: '123456789012', region: 'sa-east-1' },
  subjectPrefix: 'repo:owner@1/repo@2',
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
                'repo:owner@1/repo@2:environment:dev',
                'repo:owner@1/repo@2:environment:prod',
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

test('is deployed with the CLI credentials, outside the bootstrap roles it limits', () => {
  const stack = new GitHubOidcStack(newApp(), 'Test', props);

  expect(stack.synthesizer).toBeInstanceOf(cdk.CliCredentialsStackSynthesizer);
});

test('the boundary allows only the project services and guards itself and the deploy path', () => {
  const template = Template.fromStack(new GitHubOidcStack(newApp(), 'Test', props));
  const boundaryArn = `arn:aws:iam::123456789012:policy/${DEPLOY_BOUNDARY_NAME}`;
  const deny = (sid: string, rest: object = {}) =>
    Match.objectLike({ Sid: sid, Effect: 'Deny', ...rest });

  template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
    ManagedPolicyName: DEPLOY_BOUNDARY_NAME,
    PolicyDocument: {
      Statement: [
        {
          Sid: 'AllowProjectServices',
          Effect: 'Allow',
          Action: BOUNDARY_SERVICES.map((service) => `${service}:*`),
          Resource: '*',
        },
        deny('DenyRolesWithoutBoundary', {
          Condition: { StringNotEquals: { 'iam:PermissionsBoundary': boundaryArn } },
        }),
        deny('DenyBoundaryRemoval'),
        deny('DenyBoundaryChanges', { Resource: boundaryArn }),
        deny('DenyLongLivedIdentities'),
        deny('DenyDeployPathChanges', {
          Resource: [
            'arn:aws:iam::123456789012:role/cdk-hnb659fds-*',
            'arn:aws:iam::123456789012:role/Test-*',
          ],
        }),
        deny('DenyStagingChanges', {
          Resource: [
            'arn:aws:s3:::cdk-hnb659fds-assets-123456789012-sa-east-1',
            'arn:aws:s3:::cdk-hnb659fds-assets-123456789012-sa-east-1/*',
          ],
        }),
        deny('DenyBootstrapVersionChanges', {
          Resource: 'arn:aws:ssm:sa-east-1:123456789012:parameter/cdk-bootstrap/hnb659fds/version',
        }),
      ],
    },
  });
  // CloudFormation stays out, which keeps the bootstrap stack and this one out of reach.
  expect(BOUNDARY_SERVICES).not.toContain('cloudformation');
  expect(BOUNDARY_SERVICES).not.toContain('sts');
});

interface PolicyDocumentJson {
  Statement: { Action: string | string[] }[];
}
interface ResourceJson {
  Type: string;
  Properties?: {
    PermissionsBoundary?: unknown;
    PolicyDocument?: PolicyDocumentJson;
    Policies?: { PolicyDocument: PolicyDocumentJson }[];
  };
}

// Service prefix of each CloudFormation resource namespace the stage stacks use.
const RESOURCE_SERVICES: Record<string, string> = {
  ApiGatewayV2: 'apigateway',
  CloudFront: 'cloudfront',
  CloudWatch: 'cloudwatch',
  DynamoDB: 'dynamodb',
  IAM: 'iam',
  Lambda: 'lambda',
  Logs: 'logs',
  S3: 's3',
  Scheduler: 'scheduler',
};

test.each(['dev', 'prod'] as const)(
  'the boundary covers every role, resource and action of the %s stack',
  (stage) => {
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const stack = new BackendStack(app, 'Test', {
      stage,
      env: props.env,
      frontendDistPath: '__nonexistent_for_unit_test__',
      permissionsBoundary: cdk.PermissionsBoundary.fromName(DEPLOY_BOUNDARY_NAME),
    });
    const { Resources, Parameters } = Template.fromStack(stack).toJSON();
    const resources = Object.values(Resources) as ResourceJson[];
    const used = new Set<string>();

    for (const { Type, Properties } of resources) {
      if (Type === 'AWS::IAM::Role') {
        expect(JSON.stringify(Properties?.PermissionsBoundary)).toContain(DEPLOY_BOUNDARY_NAME);
      }
      const [prefix, namespace] = Type.split('::');
      if (prefix === 'AWS' && namespace !== 'CDK') used.add(RESOURCE_SERVICES[namespace!] ?? Type);
      const documents = [
        Properties?.PolicyDocument,
        ...(Properties?.Policies ?? []).map((policy) => policy.PolicyDocument),
      ];
      for (const document of documents.filter((d) => d !== undefined)) {
        for (const statement of document.Statement) {
          for (const action of [statement.Action].flat())
            used.add(action.slice(0, action.indexOf(':')));
        }
      }
    }
    // CloudFormation reads the bootstrap version from SSM with the execution role.
    for (const { Type } of Object.values(Parameters ?? {}) as { Type: string }[]) {
      if (Type.startsWith('AWS::SSM::Parameter')) used.add('ssm');
    }

    expect([...used].filter((service) => !BOUNDARY_SERVICES.includes(service))).toEqual([]);
  },
);
