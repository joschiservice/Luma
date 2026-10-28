import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import cdk from '../cdk.json' with { type: 'json' };
import { buildLumaApp } from './luma-app.js';
import { readCellSettings } from './settings.js';

function synthesize(context: Record<string, string> = {}) {
  const app = new App({ context: { ...cdk.context, ...context } });
  const stacks = buildLumaApp(app);
  // Runs the cdk-nag AWS Solutions checks; any unacknowledged finding throws.
  app.synth();

  return stacks;
}

describe('Luma CDK app', () => {
  it('synthesizes every stack without unacknowledged cdk-nag findings', () => {
    expect(() => synthesize()).not.toThrow();
  });

  it('keeps containers away from the instance role and state off the root volume', () => {
    const { cells } = synthesize();
    const cell = Template.fromStack(cells[0]!.cell);

    cell.hasResourceProperties('AWS::EC2::Instance', {
      MetadataOptions: Match.objectLike({
        HttpTokens: 'required',
        HttpPutResponseHopLimit: 1,
      }),
    });
    cell.hasResource('AWS::EC2::Volume', {
      Properties: Match.objectLike({ Encrypted: true, VolumeType: 'gp3' }),
      DeletionPolicy: 'Snapshot',
    });
    cell.resourceCountIs('AWS::EC2::NatGateway', 0);
    cell.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
  });

  it('opens only web ports to the internet', () => {
    const { cells } = synthesize();
    const ingress = Template.fromStack(cells[0]!.cell).findResources(
      'AWS::EC2::SecurityGroup',
      {
        Properties: {
          GroupDescription: Match.stringLikeRegexp('Public HTTPS'),
        },
      },
    );
    const rules = Object.values(ingress).flatMap(
      (group) =>
        (
          group as {
            Properties: { SecurityGroupIngress: { FromPort: number }[] };
          }
        ).Properties.SecurityGroupIngress,
    );

    expect(rules.map((rule) => rule.FromPort).sort()).toEqual([443, 443, 80]);
  });

  it('retains data-bearing foundation resources', () => {
    const { cells } = synthesize();
    const foundation = Template.fromStack(cells[0]!.foundation);

    for (const type of [
      'AWS::KMS::Key',
      'AWS::ECR::Repository',
      'AWS::S3::Bucket',
    ])
      foundation.hasResource(type, { DeletionPolicy: 'Retain' });
    foundation.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    });
  });

  it('keeps every backup version locked for its retention period', () => {
    const { cells } = synthesize();

    Template.fromStack(cells[0]!.foundation).hasResourceProperties(
      'AWS::S3::Bucket',
      {
        VersioningConfiguration: { Status: 'Enabled' },
        ObjectLockEnabled: true,
        ObjectLockConfiguration: {
          ObjectLockEnabled: 'Enabled',
          Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 35 } },
        },
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              ExpirationInDays: 35,
              NoncurrentVersionExpiration: { NoncurrentDays: 1 },
            }),
          ]),
        },
      },
    );
  });

  it('copies data volume snapshots into a retained vault in Melbourne', () => {
    const { cells } = synthesize();
    const { cell, snapshotCopies } = cells[0]!;

    expect(snapshotCopies.region).toBe('ap-southeast-4');
    Template.fromStack(snapshotCopies).hasResource('AWS::Backup::BackupVault', {
      Properties: { BackupVaultName: 'luma-staging-snapshot-copies' },
      DeletionPolicy: 'Retain',
    });
    Template.fromStack(cell).hasResourceProperties('AWS::Backup::BackupPlan', {
      BackupPlan: {
        BackupPlanRule: [
          Match.objectLike({
            CopyActions: [
              {
                DestinationBackupVaultArn: {
                  'Fn::Join': [
                    '',
                    [
                      'arn:aws:backup:ap-southeast-4:',
                      { Ref: 'AWS::AccountId' },
                      ':backup-vault:luma-staging-snapshot-copies',
                    ],
                  ],
                },
                Lifecycle: { DeleteAfterDays: 7 },
              },
            ],
          }),
        ],
      },
    });
  });

  it('lets only the stage environment of this repository assume the deploy role', () => {
    const { cells } = synthesize();

    Template.fromStack(cells[1]!.foundation).hasResourceProperties(
      'AWS::IAM::Role',
      {
        RoleName: 'luma-production-github-deploy',
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: [
            Match.objectLike({
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:aud':
                    'sts.amazonaws.com',
                  'token.actions.githubusercontent.com:sub':
                    'repo:joschiservice/Luma:environment:production',
                },
              },
            }),
          ],
        }),
      },
    );
  });

  it('lets the deploy role run only the deploy document, which accepts only an image tag and digest', () => {
    const foundation = Template.fromStack(synthesize().cells[1]!.foundation);

    foundation.hasResourceProperties('AWS::SSM::Document', {
      Name: 'luma-production-deploy',
      DocumentType: 'Command',
      Content: Match.objectLike({
        parameters: {
          imageTag: Match.objectLike({
            allowedPattern: '^[A-Za-z0-9._-]{1,128}$',
          }),
          imageDigest: Match.objectLike({
            default: '',
            allowedPattern: '^(sha256:[0-9a-f]{64})?$',
          }),
        },
        mainSteps: [
          Match.objectLike({
            inputs: Match.objectLike({
              runCommand: [
                'bash /opt/luma/bin/luma-deploy {{ imageTag }} {{ imageDigest }}',
              ],
            }),
          }),
        ],
      }),
    });
    const policies = JSON.stringify(
      foundation.findResources('AWS::IAM::Policy'),
    );
    expect(policies).not.toContain('AWS-RunShellScript');
    foundation.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Action: 'ssm:SendCommand',
            Effect: 'Allow',
            Resource: {
              'Fn::Join': [
                '',
                [
                  'arn:aws:ssm:ap-southeast-2:',
                  { Ref: 'AWS::AccountId' },
                  ':document/',
                  { Ref: 'DeployCommand' },
                ],
              ],
            },
          },
        ]),
      },
    });
  });

  it('pins the host image and waits for the host to signal', () => {
    const cell = Template.fromStack(
      synthesize({ 'luma:staging:hostImage': 'ami-0123456789abcdef0' })
        .cells[0]!.cell,
    );

    cell.hasResource('AWS::EC2::Instance', {
      Properties: Match.objectLike({ ImageId: 'ami-0123456789abcdef0' }),
      CreationPolicy: { ResourceSignal: { Timeout: 'PT20M' } },
    });
    // The signal must come before host setup, which waits for the previous host's volume.
    const [instance] = Object.values(
      cell.findResources('AWS::EC2::Instance'),
    ) as { Properties: { UserData: unknown } }[];
    const userData = JSON.stringify(instance!.Properties.UserData);
    expect(userData.indexOf('--exit-code 0')).toBeGreaterThan(0);
    expect(userData.indexOf('--exit-code 0')).toBeLessThan(
      userData.indexOf('luma-host-setup'),
    );
  });

  it('alarms on host memory and disks, missing backups and logged failures', () => {
    const cell = Template.fromStack(synthesize().cells[0]!.cell);

    for (const [metric, dimensions] of [
      ['mem_used_percent', [{ Name: 'Stage', Value: 'staging' }]],
      [
        'disk_used_percent',
        Match.arrayWith([{ Name: 'path', Value: '/var/lib/luma' }]),
      ],
      ['disk_used_percent', Match.arrayWith([{ Name: 'path', Value: '/' }])],
    ] as const)
      for (const threshold of [80, 90])
        cell.hasResourceProperties('AWS::CloudWatch::Alarm', {
          Namespace: 'Luma/Lite',
          MetricName: metric,
          Dimensions: dimensions,
          Threshold: threshold,
        });
    cell.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'BackupCompleted',
      Period: 3600,
      EvaluationPeriods: 26,
      DatapointsToAlarm: 26,
      ComparisonOperator: 'LessThanThreshold',
      TreatMissingData: 'breaching',
    });
    for (const pattern of [
      '{ ($.level = 50) && ($.msg = "Request failed") }',
      '{ ($.logger = "http.log.access*") && ($.status >= 500) }',
      '{ $.message = "Activity failed" }',
      '"Sync pass failed"',
    ])
      cell.hasResourceProperties('AWS::Logs::MetricFilter', {
        FilterPattern: pattern,
      });
    cell.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Action: 'cloudwatch:PutMetricData',
            Effect: 'Allow',
            Resource: '*',
            Condition: {
              StringEquals: { 'cloudwatch:namespace': 'Luma/Lite' },
            },
          },
        ]),
      },
    });
    // Without a domain the public host name is unknown, so there is no external probe.
    cell.resourceCountIs('AWS::Events::Rule', 0);
  });

  it('verifies a mail identity, its sender and an external probe with a domain', () => {
    const { foundation, cell } = synthesize({
      'luma:staging:domain': 'staging.example.com',
    }).cells[0]!;
    const cellTemplate = Template.fromStack(cell);

    cellTemplate.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'staging.example.com',
      MailFromAttributes: { MailFromDomain: 'mail.staging.example.com' },
    });
    cellTemplate.hasResourceProperties('AWS::SES::ConfigurationSet', {
      Name: 'luma-staging',
      SuppressionOptions: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] },
    });
    // The app host, three DKIM records, MAIL FROM MX and SPF, and the smoke inbox MX.
    cellTemplate.resourceCountIs('AWS::Route53::RecordSet', 1 + 3 + 2 + 1);
    cellTemplate.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/luma/staging/host/MAIL_CONFIGURATION_SET',
      Value: 'luma-staging',
    });
    cellTemplate.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          PROBE_URL: 'https://au.app.staging.example.com/api/ready',
        },
      },
    });
    cellTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Namespace: 'AWS/Lambda',
      MetricName: 'Errors',
      TreatMissingData: 'breaching',
    });
    Template.fromStack(foundation).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'ses:SendEmail',
            Condition: {
              StringLike: {
                'ses:FromAddress': [
                  '*@staging.example.com',
                  '*@staging.example.com>',
                ],
              },
            },
          }),
        ],
      },
    });
    Template.fromStack(synthesize().cells[0]!.cell).resourceCountIs(
      'AWS::SES::EmailIdentity',
      0,
    );
  });

  it('builds images only in staging and promotes them to production once both accounts are set', () => {
    const accounts = {
      'luma:staging:account': '111111111111',
      'luma:staging:hostImage': 'ami-0123456789abcdef0',
      'luma:production:account': '222222222222',
      'luma:production:hostImage': 'ami-0123456789abcdef0',
      'luma:alertEmail': 'ops@example.com',
    };
    const [staging, production] = synthesize(accounts).cells.map(
      ({ foundation }) => Template.fromStack(foundation),
    );

    staging!.hasResourceProperties('AWS::ECR::ReplicationConfiguration', {
      ReplicationConfiguration: {
        Rules: [
          {
            Destinations: [
              { Region: 'ap-southeast-2', RegistryId: '222222222222' },
            ],
            RepositoryFilters: [
              { Filter: 'luma/server', FilterType: 'PREFIX_MATCH' },
            ],
          },
        ],
      },
    });
    staging!.resourceCountIs('AWS::ECR::RegistryPolicy', 0);
    production!.resourceCountIs('AWS::ECR::ReplicationConfiguration', 0);
    production!.hasResourceProperties('AWS::ECR::RegistryPolicy', {
      PolicyText: {
        Statement: [
          Match.objectLike({
            Principal: { AWS: 'arn:aws:iam::111111111111:root' },
            Action: ['ecr:ReplicateImage'],
            Resource: Match.anyValue(),
          }),
        ],
      },
    });
    // Production's deploy role reads images and never pushes them.
    const productionPolicies = JSON.stringify(
      production!.findResources('AWS::IAM::Policy'),
    );
    expect(productionPolicies).toContain('ecr:DescribeImages');
    expect(productionPolicies).not.toContain('ecr:PutImage');
    expect(
      JSON.stringify(staging!.findResources('AWS::IAM::Policy')),
    ).toContain('ecr:PutImage');

    for (const { foundation } of synthesize().cells) {
      const template = Template.fromStack(foundation);
      template.resourceCountIs('AWS::ECR::ReplicationConfiguration', 0);
      template.resourceCountIs('AWS::ECR::RegistryPolicy', 0);
    }
    expect(() =>
      synthesize({ ...accounts, 'luma:staging:account': '' }),
    ).toThrow('luma:staging:account is required');
  });

  it('receives staging smoke mail into a private expiring bucket the deploy role can read', () => {
    const { foundation, cell } = synthesize({
      'luma:staging:domain': 'staging.example.com',
    }).cells[0]!;
    const cellTemplate = Template.fromStack(cell);

    cellTemplate.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'inbox.staging.example.com.',
      Type: 'MX',
      ResourceRecords: ['10 inbound-smtp.ap-southeast-2.amazonaws.com'],
    });
    cellTemplate.hasResource('AWS::S3::Bucket', {
      Properties: Match.objectLike({
        PublicAccessBlockConfiguration: Match.objectLike({
          BlockPublicPolicy: true,
        }),
        BucketEncryption: Match.anyValue(),
        LifecycleConfiguration: {
          Rules: [Match.objectLike({ ExpirationInDays: 1 })],
        },
      }),
      DeletionPolicy: 'Retain',
    });
    cellTemplate.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Effect: 'Deny', Action: 's3:*' }),
          Match.objectLike({
            Principal: { Service: 'ses.amazonaws.com' },
            Action: 's3:PutObject',
            Condition: {
              StringEquals: {
                'aws:SourceAccount': { Ref: 'AWS::AccountId' },
                'aws:SourceArn': Match.anyValue(),
              },
            },
          }),
        ]),
      },
    });
    cellTemplate.hasResourceProperties('AWS::SES::ReceiptRuleSet', {
      RuleSetName: 'luma-staging-smoke-inbox',
    });
    cellTemplate.hasResourceProperties('AWS::SES::ReceiptRule', {
      Rule: Match.objectLike({
        Name: 'store',
        Recipients: ['inbox.staging.example.com'],
        ScanEnabled: true,
        TlsPolicy: 'Require',
        Actions: [{ S3Action: { BucketName: Match.anyValue() } }],
      }),
    });
    const deployPolicies = JSON.stringify(
      Template.fromStack(foundation).findResources('AWS::IAM::Policy'),
    );
    expect(deployPolicies).toContain('luma-staging-smoke-inbox-');
    expect(deployPolicies).toContain('s3:GetObject');

    const production = synthesize({
      'luma:production:domain': 'example.com',
    }).cells[1]!;
    Template.fromStack(production.cell).resourceCountIs(
      'AWS::SES::ReceiptRuleSet',
      0,
    );
    expect(
      JSON.stringify(
        Template.fromStack(production.foundation).findResources(
          'AWS::IAM::Policy',
        ),
      ),
    ).not.toContain('smoke-inbox');
    Template.fromStack(synthesize().cells[0]!.cell).resourceCountIs(
      'AWS::SES::ReceiptRuleSet',
      0,
    );
  });

  it('requires a pinned image for deployable stages and an alert address for production', () => {
    const context = (values: Record<string, string>) => (key: string) =>
      values[key];
    const account = '123456789012';
    const hostImage = 'ami-0123456789abcdef0';

    expect(() =>
      readCellSettings('staging', context({ 'luma:staging:account': account })),
    ).toThrow('hostImage is required');
    expect(() =>
      readCellSettings(
        'production',
        context({
          'luma:production:account': account,
          'luma:production:hostImage': hostImage,
        }),
      ),
    ).toThrow('alertEmail');
    expect(
      readCellSettings(
        'production',
        context({
          'luma:production:account': account,
          'luma:production:hostImage': hostImage,
          'luma:alertEmail': 'ops@example.com',
        }),
      ),
    ).toMatchObject({ account, hostImage, alertEmail: 'ops@example.com' });
    expect(() =>
      readCellSettings(
        'staging',
        context({ 'luma:staging:hostImage': 'ami-xyz' }),
      ),
    ).toThrow('AMI ID');
  });

  it('denies regional actions outside the approved Australian regions', () => {
    const { organization } = synthesize({
      'luma:organization:targets': 'ou-abcd-11111111',
    });

    Template.fromStack(organization).hasResourceProperties(
      'AWS::Organizations::Policy',
      {
        Type: 'SERVICE_CONTROL_POLICY',
        TargetIds: ['ou-abcd-11111111'],
        Content: Match.objectLike({
          Statement: [
            Match.objectLike({
              Effect: 'Deny',
              Condition: {
                StringNotEquals: {
                  'aws:RequestedRegion': ['ap-southeast-2', 'ap-southeast-4'],
                },
              },
            }),
          ],
        }),
      },
    );
  });

  it('adds a hosted zone and app record only when a domain is configured', () => {
    expect(
      Template.fromStack(synthesize().cells[0]!.cell).findResources(
        'AWS::Route53::HostedZone',
      ),
    ).toEqual({});

    const cell = Template.fromStack(
      synthesize({ 'luma:staging:domain': 'staging.example.com' }).cells[0]!
        .cell,
    );
    cell.hasResourceProperties('AWS::Route53::HostedZone', {
      Name: 'staging.example.com.',
    });
    cell.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'au.app.staging.example.com.',
      Type: 'A',
    });
    cell.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/luma/staging/host/DOMAIN',
      Value: 'staging.example.com',
    });
  });

  it('recreates the data volume from a restore snapshot', () => {
    const cell = Template.fromStack(
      synthesize({ 'luma:staging:restoreSnapshot': 'snap-0123456789abcdef0' })
        .cells[0]!.cell,
    );

    cell.hasResourceProperties('AWS::EC2::Volume', {
      SnapshotId: 'snap-0123456789abcdef0',
    });
  });

  it('rejects malformed account IDs, domains and snapshots', () => {
    expect(() => synthesize({ 'luma:staging:account': '1234' })).toThrow(
      '12-digit',
    );
    expect(() => synthesize({ 'luma:staging:domain': 'Example.COM' })).toThrow(
      'lowercase DNS name',
    );
    expect(() =>
      synthesize({ 'luma:staging:restoreSnapshot': 'vol-1' }),
    ).toThrow('EBS snapshot ID');
  });
});
