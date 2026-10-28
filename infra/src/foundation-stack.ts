import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

import { acknowledge, acknowledgeWildcards, nagAccount } from './nag.js';
import { approvedRegions, cellRegion, type CellSettings } from './settings.js';

export interface FoundationStackProps extends StackProps {
  readonly settings: CellSettings;
  /**
   * The staging and production accounts once both are known. Staging then replicates its server
   * images to production, which accepts them; production deploys only those images.
   */
  readonly promotion?: {
    readonly staging: string;
    readonly production: string;
  };
}

/**
 * Long-lived resources of one stage's account that outlive any cell topology: the Temporal
 * payload key, server images, database backups, alerting, the cost budget, the GitHub
 * deployment role with its deploy command, and the narrowly scoped principals the application
 * signs AWS requests with. Data-bearing resources are retained when the stack is deleted.
 */
export class FoundationStack extends Stack {
  readonly temporalKey: kms.Key;
  readonly repository: ecr.Repository;
  readonly backupBucket: s3.Bucket;
  readonly alerts: sns.Topic;
  readonly temporalKeyUser: iam.User;
  readonly bedrockUser: iam.User;
  /** Sends mail through the cell's SES identity; exists only when the stage has a domain. */
  readonly mailUser?: iam.User;
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: FoundationStackProps) {
    super(scope, id, props);
    const { stage, github, alertEmail, monthlyBudgetUsd, domain } =
      props.settings;
    const { promotion } = props;

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

    // Images are built once in staging and promoted: the staging registry replicates every
    // `luma/server` image to production's repository of the same name, which production's
    // registry policy lets only the staging account write. Production's repository exists in
    // this stack, so the policy does not grant repository creation.
    if (promotion && stage === 'staging')
      new ecr.CfnReplicationConfiguration(this, 'ImagePromotion', {
        replicationConfiguration: {
          rules: [
            {
              destinations: [
                { region: cellRegion, registryId: promotion.production },
              ],
              repositoryFilters: [
                {
                  filter: 'luma/server',
                  filterType: 'PREFIX_MATCH',
                },
              ],
            },
          ],
        },
      });
    if (promotion && stage === 'production')
      new ecr.CfnRegistryPolicy(this, 'PromotedImages', {
        policyText: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'ReplicateFromStaging',
              Effect: 'Allow',
              Principal: { AWS: `arn:aws:iam::${promotion.staging}:root` },
              Action: ['ecr:ReplicateImage'],
              Resource: this.repository.repositoryArn,
            },
          ],
        },
      });

    this.backupBucket = new s3.Bucket(this, 'DatabaseBackups', {
      bucketName: backupBucketName(this, stage),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // Object Lock keeps every dump for its retention period even from an account
      // administrator in governance mode without the explicit bypass permission. Expiry adds a
      // delete marker after 35 days; the locked version then expires a day later.
      versioned: true,
      objectLockEnabled: true,
      objectLockDefaultRetention: s3.ObjectLockRetention.governance(
        Duration.days(35),
      ),
      lifecycleRules: [
        {
          expiration: Duration.days(35),
          noncurrentVersionExpiration: Duration.days(1),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
        { expiredObjectDeleteMarker: true },
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

    // Mail leaves through the stage domain's SES identity, which the cell stack verifies in its
    // hosted zone. The principal sends only from that domain and through its configuration set,
    // which suppresses addresses that bounced or complained.
    if (domain) {
      this.mailUser = new iam.User(this, 'MailUser', {
        userName: `luma-${stage}-mail`,
      });
      this.mailUser.addToPolicy(
        new iam.PolicyStatement({
          actions: ['ses:SendEmail'],
          resources: [
            this.formatArn({
              service: 'ses',
              resource: 'identity',
              resourceName: domain,
            }),
            this.formatArn({
              service: 'ses',
              resource: 'configuration-set',
              resourceName: mailConfigurationSetName(stage),
            }),
          ],
          conditions: {
            StringLike: { 'ses:FromAddress': [`*@${domain}`, `*@${domain}>`] },
          },
        }),
      );
    }

    // The deploy role may run only this command, which accepts nothing but an image tag and,
    // optionally, the digest the tag must point to.
    const deployDocument = new ssm.CfnDocument(this, 'DeployCommand', {
      name: deployDocumentName(stage),
      documentType: 'Command',
      // A named document cannot be replaced in place; content changes add a version instead.
      updateMethod: 'NewVersion',
      content: {
        schemaVersion: '2.2',
        description: 'Deploys one server image tag to the Lite cell host.',
        parameters: {
          imageTag: {
            type: 'String',
            description: 'An existing tag of the luma/server image.',
            allowedPattern: '^[A-Za-z0-9._-]{1,128}$',
          },
          imageDigest: {
            type: 'String',
            description:
              'The digest the tag must point to; the host then runs the image by digest.',
            default: '',
            allowedPattern: '^(sha256:[0-9a-f]{64})?$',
          },
        },
        mainSteps: [
          {
            action: 'aws:runShellScript',
            name: 'deploy',
            inputs: {
              timeoutSeconds: '3600',
              runCommand: [
                'bash /opt/luma/bin/luma-deploy {{ imageTag }} {{ imageDigest }}',
              ],
            },
          },
        ],
      },
    });

    const githubActions = new iam.OidcProviderNative(this, 'GitHubActions', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });
    this.deployRole = new iam.Role(this, 'DeployRole', {
      roleName: `luma-${stage}-github-deploy`,
      description:
        stage === 'production'
          ? 'Lets the GitHub deploy workflow read promoted images and run the host deploy command.'
          : 'Lets the GitHub deploy workflow push images and run the host deploy command.',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(githubActions.oidcProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
          'token.actions.githubusercontent.com:sub': `repo:${github.repository}:environment:${github.environment}`,
        },
      }),
    });
    // Production never builds: it deploys only images promoted from staging.
    if (stage === 'production') this.repository.grantPull(this.deployRole);
    else this.repository.grantPullPush(this.deployRole);
    this.repository.grant(this.deployRole, 'ecr:DescribeImages');
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [
          this.formatArn({
            service: 'ssm',
            resource: 'document',
            resourceName: deployDocument.ref,
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
    // The staging smoke journey reads the confirmation and invitation mail its accounts receive.
    if (stage === 'staging' && domain) {
      const inbox = smokeInboxBucketName(this, stage);
      this.deployRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [`arn:aws:s3:::${inbox}/*`],
        }),
      );
      this.deployRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['s3:ListBucket'],
          resources: [`arn:aws:s3:::${inbox}`],
        }),
      );
      acknowledgeWildcards(
        this.deployRole,
        'Reads only the staging smoke inbox, which holds synthetic mail for a day.',
        [
          `Resource::arn:aws:s3:::luma-${stage}-smoke-inbox-${nagAccount(this)}-${this.region}/*`,
        ],
      );
    }
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

/** The SES configuration set every message of the stage is sent through. */
export function mailConfigurationSetName(stage: string) {
  return `luma-${stage}`;
}

/** The SSM command document the GitHub deploy workflow runs on the host. */
function deployDocumentName(stage: string) {
  return `luma-${stage}-deploy`;
}

/**
 * The stage's backup bucket name. It is derived rather than generated so the cell stack can
 * grant access to it without a cross-stack reference.
 */
export function backupBucketName(scope: Stack, stage: string) {
  return `luma-${stage}-backups-${scope.account}-${scope.region}`;
}

/**
 * The bucket SES stores the staging smoke journey's received mail in. Derived like the backup
 * bucket, so the foundation's deploy role can read it without a cross-stack reference.
 */
export function smokeInboxBucketName(scope: Stack, stage: string) {
  return `luma-${stage}-smoke-inbox-${scope.account}-${scope.region}`;
}
