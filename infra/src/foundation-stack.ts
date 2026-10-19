import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';

import { acknowledge, acknowledgeWildcards, nagAccount } from './nag.js';
import { approvedRegions, type CellSettings } from './settings.js';

export interface FoundationStackProps extends StackProps {
  readonly settings: CellSettings;
}

/**
 * Long-lived resources of one stage's account that outlive any cell topology: the Temporal
 * payload key, server images, database backups, alerting, the cost budget, the GitHub
 * deployment role and the narrowly scoped principals the application signs AWS requests with.
 * Data-bearing resources are retained when the stack is deleted.
 */
export class FoundationStack extends Stack {
  readonly temporalKey: kms.Key;
  readonly repository: ecr.Repository;
  readonly backupBucket: s3.Bucket;
  readonly alerts: sns.Topic;
  readonly temporalKeyUser: iam.User;
  readonly bedrockUser: iam.User;
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);
    const { stage, github, alertEmail, monthlyBudgetUsd } = props.settings;

    this.temporalKey = new kms.Key(this, 'TemporalPayloadKey', {
      alias: `luma/${stage}/temporal-payloads`,
      description: 'Envelope encryption for Temporal payloads of the AU cell.',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.repository = new ecr.Repository(this, 'ServerImages', {
      repositoryName: 'luma/server',
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 30 }],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.backupBucket = new s3.Bucket(this, 'DatabaseBackups', {
      bucketName: backupBucketName(this, stage),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [
        {
          expiration: Duration.days(35),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    acknowledge(this.backupBucket, [
      {
        id: 'AwsSolutions::AwsSolutions-S1',
        reason:
          'Only the cell host writes backups; access logging would add a second bucket and cost.',
      },
    ]);

    this.alerts = new sns.Topic(this, 'Alerts', {
      displayName: `Luma ${stage} alerts`,
      enforceSSL: true,
    });
    if (alertEmail)
      this.alerts.addSubscription(
        new subscriptions.EmailSubscription(alertEmail),
      );
    acknowledge(this.alerts, [
      {
        id: 'AwsSolutions::AwsSolutions-SNS2',
        reason:
          'Alarm notifications carry no tenant data; CloudWatch cannot publish with the AWS managed SNS key.',
      },
    ]);

    // Temporal clients and workers sign KMS requests with this principal's key and nothing
    // else; the encryption context binds every data key to Luma's Temporal codec.
    this.temporalKeyUser = new iam.User(this, 'TemporalKeyUser', {
      userName: `luma-${stage}-temporal-kms`,
    });
    this.temporalKeyUser.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
        resources: [this.temporalKey.keyArn],
        conditions: {
          StringEquals: {
            'kms:EncryptionContext:application': 'luma-temporal-v1',
          },
        },
      }),
    );

    // The dedicated model gateway principal described in the model gateway guide.
    this.bedrockUser = new iam.User(this, 'BedrockUser', {
      userName: `luma-${stage}-bedrock`,
    });
    this.bedrockUser.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          this.formatArn({
            service: 'bedrock',
            resource: 'inference-profile',
            resourceName: 'au.*',
          }),
          ...approvedRegions.map(
            (region) => `arn:aws:bedrock:${region}::foundation-model/*`,
          ),
        ],
      }),
    );
    this.bedrockUser.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:GetInferenceProfile'],
        resources: [
          this.formatArn({
            service: 'bedrock',
            resource: 'inference-profile',
            resourceName: '*',
          }),
        ],
      }),
    );
    this.bedrockUser.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:GetAccountDataRetention',
          'bedrock:GetModelInvocationLoggingConfiguration',
        ],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:RequestedRegion': this.region } },
      }),
    );
    acknowledgeWildcards(
      this.bedrockUser,
      'Routes choose the model and Australian profile; account-level Bedrock reads have no resource ARN.',
      [
        `Resource::arn:aws:bedrock:${this.region}:${nagAccount(this)}:inference-profile/au.*`,
        `Resource::arn:aws:bedrock:${this.region}:${nagAccount(this)}:inference-profile/*`,
        ...approvedRegions.map(
          (region) => `Resource::arn:aws:bedrock:${region}::foundation-model/*`,
        ),
        'Resource::*',
      ],
    );

    const githubActions = new iam.OidcProviderNative(this, 'GitHubActions', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });
    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: `luma-${stage}-github-deploy`,
      description:
        'Lets the GitHub deploy workflow push images and run the host deploy command.',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(githubActions.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${github.repository}:environment:${github.environment}`,
        },
      }),
    });
    this.repository.grantPullPush(this.deployRole);
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [
          this.formatArn({
            service: 'ssm',
            account: '',
            resource: 'document',
            resourceName: 'AWS-RunShellScript',
          }),
        ],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [
          this.formatArn({
            service: 'ec2',
            resource: 'instance',
            resourceName: '*',
          }),
        ],
        conditions: {
          StringEquals: { 'ssm:resourceTag/luma:cell': `lite-${stage}` },
        },
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ssm:GetCommandInvocation',
          'ssm:ListCommandInvocations',
          'ec2:DescribeInstances',
        ],
        resources: ['*'],
      }),
    );
    acknowledgeWildcards(
      this.deployRole,
      'Commands reach only instances tagged for this cell; registry login, command reads and instance lookup have no resource ARN.',
      [
        `Resource::arn:aws:ec2:${this.region}:${nagAccount(this)}:instance/*`,
        'Resource::*',
      ],
    );

    new CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `luma-${stage}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: monthlyBudgetUsd, unit: 'USD' },
      },
      notificationsWithSubscribers: alertEmail
        ? [
            budgetAlert('ACTUAL', 80, alertEmail),
            budgetAlert('FORECASTED', 100, alertEmail),
          ]
        : [],
    });
  }
}

function budgetAlert(
  notificationType: 'ACTUAL' | 'FORECASTED',
  threshold: number,
  address: string,
): CfnBudget.NotificationWithSubscribersProperty {
  return {
    notification: {
      notificationType,
      comparisonOperator: 'GREATER_THAN',
      threshold,
      thresholdType: 'PERCENTAGE',
    },
    subscribers: [{ subscriptionType: 'EMAIL', address }],
  };
}

/**
 * The stage's backup bucket name. It is derived rather than generated so the cell stack can
 * grant access to it without a cross-stack reference.
 */
export function backupBucketName(scope: Stack, stage: string) {
  return `luma-${stage}-backups-${scope.account}-${scope.region}`;
}
