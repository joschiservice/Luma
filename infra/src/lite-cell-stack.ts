import { fileURLToPath } from 'node:url';

import {
  ArnFormat,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Size,
  Stack,
  type StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

import {
  backupBucketName,
  type FoundationStack,
  mailConfigurationSetName,
  smokeInboxBucketName,
} from './foundation-stack.js';
import { acknowledge, acknowledgeWildcards, nagAccount } from './nag.js';
import { cellRegion, type CellSettings } from './settings.js';
import {
  snapshotCopyRegion,
  snapshotCopyVaultName,
} from './snapshot-copy-stack.js';

/** The namespace of the metrics the host and the log filters publish. */
const hostMetricNamespace = 'Luma/Lite';

export interface LiteCellStackProps extends StackProps {
  readonly settings: CellSettings;
  readonly foundation: FoundationStack;
}

/**
 * The single-host AU cell: one Graviton instance runs every Luma process, PostgreSQL, Valkey,
 * Temporal and Caddy with Docker Compose. There is no NAT gateway or load balancer; Caddy
 * terminates TLS on the instance's Elastic IP. State lives on a separate EBS volume that the
 * host attaches itself, so replacing the instance keeps the data. Containers cannot reach the
 * instance metadata service, so they never receive the instance role's credentials.
 */
export class LiteCellStack extends Stack {
  constructor(scope: Construct, id: string, props: LiteCellStackProps) {
    super(scope, id, props);
    const { settings, foundation } = props;
    const { stage } = settings;
    const cell = `lite-${stage}`;
    const parameterPath = `/luma/${stage}`;
    Tags.of(this).add('luma:cell', cell);

    const vpc = new ec2.Vpc(this, 'Network', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
      restrictDefaultSecurityGroup: true,
    });
    acknowledge(vpc, [
      {
        id: 'AwsSolutions::AwsSolutions-VPC7',
        reason:
          'A single public host; flow logs would cost more than the host for no current consumer.',
      },
    ]);
    const subnet = vpc.publicSubnets[0]!;

    const ingress = new ec2.SecurityGroup(this, 'Ingress', {
      vpc,
      description:
        'Public HTTPS for the customer app; staff access arrives over Tailscale.',
    });
    ingress.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'ACME challenges and HTTPS redirects',
    );
    ingress.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    ingress.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(443), 'HTTP/3');
    acknowledge(ingress, [
      {
        id: 'AwsSolutions::AwsSolutions-EC23',
        reason: 'The customer app is public; only web ports are open.',
      },
    ]);

    const notify = new actions.SnsAction(foundation.alerts);
    const data = new ec2.Volume(this, 'Data', {
      availabilityZone: subnet.availabilityZone,
      size: Size.gibibytes(settings.dataVolumeGiB),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      // A replaced volume is snapshotted before deletion.
      removalPolicy: RemovalPolicy.SNAPSHOT,
      ...(settings.restoreSnapshotId
        ? { snapshotId: settings.restoreSnapshotId }
        : {}),
    });

    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName: `/luma/${stage}/lite`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.alarmOnLogFailures(logGroup, notify);

    const hostFiles = new Asset(this, 'HostFiles', {
      path: fileURLToPath(new URL('../lite', import.meta.url)),
    });

    const role = new iam.Role(this, 'HostRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description:
        'The Lite cell host: deploys, backups and SSM access. Containers cannot assume it.',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'AmazonSSMManagedInstanceCore',
        ),
      ],
    });
    const backups = backupBucketName(this, stage);
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [hostFiles.bucket.arnForObjects(hostFiles.s3ObjectKey)],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject', 's3:GetObject'],
        resources: [`arn:aws:s3:::${backups}/lite/${stage}/*`],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [`arn:aws:s3:::${backups}`],
        conditions: { StringLike: { 's3:prefix': [`lite/${stage}/*`] } },
      }),
    );
    foundation.repository.grantPull(role);
    logGroup.grant(
      role,
      'logs:CreateLogStream',
      'logs:PutLogEvents',
      'logs:DescribeLogStreams',
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
        resources: [
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: `luma/${stage}`,
          }),
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: `luma/${stage}/*`,
          }),
        ],
      }),
    );
    // The host generates database passwords, auth secrets and connection keys on first deploy
    // and keeps them here, so a replaced instance finds the same values.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter'],
        resources: [
          this.formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: `luma/${stage}/generated/*`,
          }),
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:CreateAccessKey', 'iam:ListAccessKeys'],
        resources: [
          foundation.temporalKeyUser.userArn,
          foundation.bedrockUser.userArn,
          ...(foundation.mailUser ? [foundation.mailUser.userArn] : []),
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:AttachVolume'],
        resources: [
          this.formatArn({
            service: 'ec2',
            resource: 'volume',
            resourceName: data.volumeId,
          }),
          this.formatArn({
            service: 'ec2',
            resource: 'instance',
            resourceName: '*',
          }),
        ],
        conditions: { StringEquals: { 'aws:ResourceTag/luma:cell': cell } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:DescribeVolumes'],
        resources: ['*'],
      }),
    );
    // The CloudWatch agent, the backup and the restore drill publish host metrics; failed
    // units, the watchdog and deploy rollbacks alert through the stage's topic.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'cloudwatch:namespace': hostMetricNamespace },
        },
      }),
    );
    foundation.alerts.grantPublish(role);
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudformation:SignalResource'],
        resources: [this.stackId],
      }),
    );
    acknowledge(role, [
      {
        id: 'AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore]',
        reason:
          'The AWS managed SSM core policy is the documented minimum for Session Manager and Run Command.',
      },
    ]);
    acknowledgeWildcards(
      role,
      'Limited to this stage: its parameter path, its backup prefix and instances tagged for this cell. Registry login, volume lookup and metrics, limited to the Luma/Lite namespace, have no resource ARN.',
      [
        `Resource::arn:aws:ssm:${this.region}:${nagAccount(this)}:parameter/luma/${stage}/*`,
        `Resource::arn:aws:ssm:${this.region}:${nagAccount(this)}:parameter/luma/${stage}/generated/*`,
        `Resource::arn:aws:s3:::luma-${stage}-backups-${nagAccount(this)}-${this.region}/lite/${stage}/*`,
        `Resource::arn:aws:ec2:${this.region}:${nagAccount(this)}:instance/*`,
        'Resource::*',
      ],
    );

    const hostSettings: Record<string, string> = {
      BUNDLE_URL: hostFiles.s3ObjectUrl,
      IMAGE_REPOSITORY: foundation.repository.repositoryUri,
      BACKUP_BUCKET: backups,
      LOG_GROUP: logGroup.logGroupName,
      TEMPORAL_KMS_KEY_ARN: foundation.temporalKey.keyArn,
      TEMPORAL_KMS_USER: foundation.temporalKeyUser.userName,
      BEDROCK_USER: foundation.bedrockUser.userName,
      ALERT_TOPIC_ARN: foundation.alerts.topicArn,
      ...(settings.domain ? { DOMAIN: settings.domain } : {}),
      ...(foundation.mailUser
        ? {
            MAIL_USER: foundation.mailUser.userName,
            MAIL_CONFIGURATION_SET: mailConfigurationSetName(stage),
          }
        : {}),
    };
    const parameters = Object.entries(hostSettings).map(
      ([name, value]) =>
        new ssm.StringParameter(this, `Host${name}`, {
          parameterName: `${parameterPath}/host/${name}`,
          stringValue: value,
        }),
    );

    // User data only prepares the host and fetches the first host files; each deploy then takes
    // them from the server image. It changes only when the data volume does, and then replaces
    // the instance so the new host attaches the new volume. Updating host files never restarts
    // the instance.
    const userData = ec2.UserData.forLinux();
    const host = new ec2.Instance(this, 'Host', {
      vpc,
      vpcSubnets: { subnets: [subnet] },
      instanceType: new ec2.InstanceType(settings.instanceType),
      // Deployable stages pin the image; settings require it once an account is set.
      machineImage: settings.hostImage
        ? ec2.MachineImage.genericLinux({ [cellRegion]: settings.hostImage })
        : ec2.MachineImage.latestAmazonLinux2023({
            cpuType: ec2.AmazonLinuxCpuType.ARM_64,
          }),
      role,
      securityGroup: ingress,
      userData,
      userDataCausesReplacement: true,
      // CloudFormation waits for the host's signal, so a broken image or bootstrap fails the
      // stack update instead of leaving a host that never comes up.
      resourceSignalTimeout: Duration.minutes(20),
      associatePublicIpAddress: true,
      // A hop limit of 1 keeps containers on the Docker bridge from reaching the metadata service.
      httpTokens: ec2.HttpTokens.REQUIRED,
      httpPutResponseHopLimit: 1,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(20, {
            encrypted: true,
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });
    const signal = `/opt/aws/bin/cfn-signal --region ${this.region} --stack ${this.stackName} --resource ${host.instance.logicalId} --exit-code`;
    userData.addCommands(
      'set -euo pipefail',
      'dnf install -y -q aws-cfn-bootstrap',
      `trap '${signal} 1' ERR`,
      'mkdir -p /etc/luma',
      `printf '%s\\n' 'LUMA_STAGE=${stage}' 'AWS_REGION=${this.region}' 'LUMA_DATA_VOLUME_ID=${data.volumeId}' > /etc/luma/host.env`,
      `bundle=$(aws ssm get-parameter --region ${this.region} --name ${parameterPath}/host/BUNDLE_URL --query Parameter.Value --output text)`,
      'aws s3 cp "$bundle" /tmp/luma-host-files.zip',
      'rm -rf /opt/luma && mkdir -p /opt/luma && python3 -m zipfile -e /tmp/luma-host-files.zip /opt/luma',
      // Signal before the host takes the data volume. A replacement host waits for the old one
      // to release the volume, which happens only when CloudFormation terminates the old host
      // after this resource completes; signalling after setup would deadlock the update. Setup
      // failures after this point alert through the stage's topic instead.
      'trap - ERR',
      `${signal} 0`,
      'bash /opt/luma/bin/luma-host-setup',
    );
    for (const parameter of parameters) host.node.addDependency(parameter);
    acknowledge(host, [
      {
        id: 'AwsSolutions::AwsSolutions-EC28',
        reason:
          'Basic monitoring suffices for one host; detailed monitoring adds cost.',
      },
      {
        id: 'CloudFormation-Validate::W9010',
        reason:
          'Each stage pins its host image in CDK context; operating system updates bump it in a reviewed change.',
      },
      {
        id: 'AwsSolutions::AwsSolutions-EC29',
        reason:
          'Stack updates may replace the instance to apply a new image; state lives on the retained data volume.',
      },
    ]);

    const address = new ec2.CfnEIP(this, 'Address', { domain: 'vpc' });
    new ec2.CfnEIPAssociation(this, 'AddressAssociation', {
      allocationId: address.attrAllocationId,
      instanceId: host.instanceId,
    });

    // AWS restarts the host on failed status checks and recovers it onto new hardware when the
    // underlying system fails; both notify the stage's alert topic.
    new cloudwatch.Alarm(this, 'SystemCheck', {
      alarmDescription:
        'The host hardware failed its status check; AWS recovers the instance.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/EC2',
        metricName: 'StatusCheckFailed_System',
        dimensionsMap: { InstanceId: host.instanceId },
        statistic: 'Maximum',
        period: Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    }).addAlarmAction(
      new actions.Ec2Action(actions.Ec2InstanceAction.RECOVER),
      notify,
    );
    new cloudwatch.Alarm(this, 'InstanceCheck', {
      alarmDescription:
        'The host operating system failed its status check; AWS reboots it.',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/EC2',
        metricName: 'StatusCheckFailed_Instance',
        dimensionsMap: { InstanceId: host.instanceId },
        statistic: 'Maximum',
        period: Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    }).addAlarmAction(
      new actions.Ec2Action(actions.Ec2InstanceAction.REBOOT),
      notify,
    );

    // Daily crash-consistent snapshots of the whole data volume, kept in the cell region.
    const vault = new backup.BackupVault(this, 'Snapshots', {
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const plan = new backup.BackupPlan(this, 'SnapshotPlan', {
      backupVault: vault,
      backupPlanRules: [
        new backup.BackupPlanRule({
          ruleName: 'daily',
          scheduleExpression: events.Schedule.cron({ hour: '16', minute: '0' }),
          deleteAfter: Duration.days(7),
          // A copy in Melbourne survives a Sydney regional outage.
          copyActions: [
            {
              destinationBackupVault: backup.BackupVault.fromBackupVaultArn(
                this,
                'SnapshotCopies',
                this.formatArn({
                  service: 'backup',
                  region: snapshotCopyRegion,
                  resource: 'backup-vault',
                  resourceName: snapshotCopyVaultName(stage),
                  arnFormat: ArnFormat.COLON_RESOURCE_NAME,
                }),
              ),
              deleteAfter: Duration.days(7),
            },
          ],
        }),
      ],
    });
    plan.addSelection('DataVolume', {
      resources: [
        backup.BackupResource.fromArn(
          this.formatArn({
            service: 'ec2',
            resource: 'volume',
            resourceName: data.volumeId,
          }),
        ),
      ],
    });
    acknowledge(plan, [
      {
        id: 'AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup]',
        reason: 'AWS Backup uses its documented service role policy.',
      },
    ]);

    this.alarmOnHostMetrics(stage, notify);

    if (settings.domain) {
      const zone = new route53.PublicHostedZone(this, 'Zone', {
        zoneName: settings.domain,
      });
      const appHost = `au.app.${settings.domain}`;
      new route53.ARecord(this, 'AppRecord', {
        zone,
        recordName: appHost,
        target: route53.RecordTarget.fromIpAddresses(address.attrPublicIp),
        ttl: Duration.minutes(5),
      });
      new CfnOutput(this, 'NameServers', {
        description: 'Delegate the domain to these name servers.',
        value: Fn.join(', ', zone.hostedZoneNameServers ?? []),
      });

      // Mail is sent from the stage domain. CDK publishes the DKIM and MAIL FROM records in the
      // zone; the configuration set stops sending to addresses that bounced or complained.
      const configurationSet = new ses.ConfigurationSet(this, 'MailSending', {
        configurationSetName: mailConfigurationSetName(stage),
        suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
      });
      new ses.EmailIdentity(this, 'MailIdentity', {
        identity: ses.Identity.publicHostedZone(zone),
        configurationSet,
        mailFromDomain: `mail.${settings.domain}`,
      });

      this.probeReadiness(`https://${appHost}/api/ready`, notify);
      if (stage === 'staging') this.receiveSmokeMail(zone, settings.domain);
    }

    new CfnOutput(this, 'PublicAddress', { value: address.attrPublicIp });
    new CfnOutput(this, 'InstanceId', { value: host.instanceId });
  }

  /**
   * Receives mail for `inbox.<domain>` with SES and stores each raw message in a private bucket
   * for a day, so the staging smoke journey can read its confirmation and invitation links.
   * CloudFormation cannot activate a receipt rule set; an operator activates it once.
   */
  private receiveSmokeMail(zone: route53.IHostedZone, domain: string) {
    const stage = 'staging';
    const inboxDomain = `inbox.${domain}`;
    const ruleSetName = `luma-${stage}-smoke-inbox`;
    const ruleName = 'store';
    new route53.MxRecord(this, 'SmokeInboxMx', {
      zone,
      recordName: inboxDomain,
      values: [
        {
          priority: 10,
          hostName: `inbound-smtp.${this.region}.amazonaws.com`,
        },
      ],
      ttl: Duration.minutes(5),
    });
    // Retained like every data-bearing resource; it holds only synthetic smoke mail, which
    // expires after a day.
    const bucket = new s3.Bucket(this, 'SmokeInbox', {
      bucketName: smokeInboxBucketName(this, stage),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [
        {
          expiration: Duration.days(1),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('ses.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [bucket.arnForObjects('*')],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': this.account,
            'aws:SourceArn': this.formatArn({
              service: 'ses',
              resource: 'receipt-rule-set',
              resourceName: `${ruleSetName}:receipt-rule/${ruleName}`,
            }),
          },
        },
      }),
    );
    acknowledge(bucket, [
      {
        id: 'AwsSolutions::AwsSolutions-S1',
        reason:
          'Only SES writes synthetic smoke mail that expires after a day; access logging would add a second bucket.',
      },
    ]);
    const rules = new ses.ReceiptRuleSet(this, 'SmokeInboxRules', {
      receiptRuleSetName: ruleSetName,
    });
    const rule = rules.addRule('Store', {
      receiptRuleName: ruleName,
      recipients: [inboxDomain],
      scanEnabled: true,
      tlsPolicy: ses.TlsPolicy.REQUIRE,
      // The bucket policy above grants SES exactly this rule; the CDK S3 action would add a
      // broader statement without the rule's ARN.
      actions: [
        { bind: () => ({ s3Action: { bucketName: bucket.bucketName } }) },
      ],
    });
    // SES checks that it can write to the bucket when the rule is created.
    if (bucket.policy) rule.node.addDependency(bucket.policy);
    new CfnOutput(this, 'SmokeInboxBucket', {
      description: 'Holds mail received for the staging smoke journey.',
      value: bucket.bucketName,
    });
  }

  /** Alarms on failures the application and Caddy log, counted by metric filters. */
  private alarmOnLogFailures(
    logGroup: logs.LogGroup,
    notify: actions.SnsAction,
  ) {
    const failures = [
      {
        id: 'ApiServerErrors',
        // The API logs genuine server errors as `Request failed` at pino's error level.
        pattern: logs.FilterPattern.all(
          logs.FilterPattern.numberValue('$.level', '=', 50),
          logs.FilterPattern.stringValue('$.msg', '=', 'Request failed'),
        ),
        threshold: 5,
        description: 'The API failed 5 or more requests with a server error',
      },
      {
        id: 'IngressServerErrors',
        // Caddy's access log records every response, including 502s while the API or web
        // server is down.
        pattern: logs.FilterPattern.all(
          logs.FilterPattern.stringValue('$.logger', '=', 'http.log.access*'),
          logs.FilterPattern.numberValue('$.status', '>=', 500),
        ),
        threshold: 10,
        description: 'Caddy answered 10 or more requests with a server error',
      },
      {
        id: 'ActivityFailures',
        // Temporal's worker logs every failed activity attempt. Retries are expected, so only
        // a sustained rate alarms.
        pattern: logs.FilterPattern.stringValue(
          '$.message',
          '=',
          'Activity failed',
        ),
        threshold: 20,
        description: 'Workflow activity attempts failed 20 or more times',
      },
      {
        id: 'SyncFailures',
        pattern: logs.FilterPattern.literal('"Sync pass failed"'),
        threshold: 10,
        description: 'Commerce sync passes failed 10 or more times',
      },
    ];
    for (const { id, pattern, threshold, description } of failures) {
      const filter = new logs.MetricFilter(this, `${id}Filter`, {
        logGroup,
        filterPattern: pattern,
        metricNamespace: hostMetricNamespace,
        metricName: id,
        metricValue: '1',
      });
      new cloudwatch.Alarm(this, id, {
        alarmDescription: `${description} in 5 minutes. Read the ${logGroup.logGroupName} log group.`,
        metric: filter.metric({
          statistic: 'Sum',
          period: Duration.minutes(5),
        }),
        threshold,
        evaluationPeriods: 1,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(notify);
    }
  }

  /**
   * Alarms on the metrics the host publishes. The CloudWatch agent and the host scripts set
   * only a Stage dimension (disks add path and file system), so alarms survive a replaced
   * instance.
   */
  private alarmOnHostMetrics(stage: string, notify: actions.SnsAction) {
    const usage: {
      id: string;
      metricName: string;
      dimensions: Record<string, string>;
      label: string;
      evaluationPeriods: number;
    }[] = [
      {
        id: 'Memory',
        metricName: 'mem_used_percent',
        dimensions: {},
        label: 'Host memory',
        evaluationPeriods: 3,
      },
      {
        id: 'RootDisk',
        metricName: 'disk_used_percent',
        dimensions: { path: '/', fstype: 'xfs' },
        label: 'The root volume',
        evaluationPeriods: 1,
      },
      {
        id: 'DataDisk',
        metricName: 'disk_used_percent',
        dimensions: { path: '/var/lib/luma', fstype: 'xfs' },
        label: 'The data volume',
        evaluationPeriods: 1,
      },
    ];
    for (const {
      id,
      metricName,
      dimensions,
      label,
      evaluationPeriods,
    } of usage)
      for (const [level, threshold] of [
        ['Warning', 80],
        ['Critical', 90],
      ] as const)
        new cloudwatch.Alarm(this, `${id}${level}`, {
          alarmDescription: `${label} is more than ${threshold}% used.`,
          metric: new cloudwatch.Metric({
            namespace: hostMetricNamespace,
            metricName,
            dimensionsMap: { Stage: stage, ...dimensions },
            statistic: 'Maximum',
            period: Duration.minutes(5),
          }),
          threshold,
          evaluationPeriods,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }).addAlarmAction(notify);

    // The daily backup publishes one data point on success; 26 hours without one alarms.
    new cloudwatch.Alarm(this, 'BackupMissing', {
      alarmDescription:
        'No logical database backup completed in the last 26 hours. Read journalctl -u luma-backup on the host.',
      metric: new cloudwatch.Metric({
        namespace: hostMetricNamespace,
        metricName: 'BackupCompleted',
        dimensionsMap: { Stage: stage },
        statistic: 'Sum',
        period: Duration.hours(1),
      }),
      threshold: 1,
      evaluationPeriods: 26,
      datapointsToAlarm: 26,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }).addAlarmAction(notify);
  }

  /**
   * Requests the readiness endpoint from Sydney every minute through the public name, as a
   * customer would. A failed probe fails the function; the alarm counts failed or missing
   * invocations.
   */
  private probeReadiness(url: string, notify: actions.SnsAction) {
    const logGroup = new logs.LogGroup(this, 'ReadinessProbeLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const role = new iam.Role(this, 'ReadinessProbeRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Writes the readiness probe logs and nothing else.',
    });
    logGroup.grantWrite(role);
    const probe = new lambda.Function(this, 'ReadinessProbe', {
      description: `Requests ${url} and fails unless it answers successfully.`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
exports.handler = async () => {
  const response = await fetch(process.env.PROBE_URL, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Readiness probe answered ' + response.status);
};`),
      environment: { PROBE_URL: url },
      memorySize: 128,
      timeout: Duration.seconds(15),
      retryAttempts: 0,
      role,
      logGroup,
    });
    new events.Rule(this, 'ReadinessProbeSchedule', {
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new targets.LambdaFunction(probe, { retryAttempts: 0 })],
    });
    new cloudwatch.Alarm(this, 'AppUnreachable', {
      alarmDescription: `${url} failed in 3 of the last 5 minutes from Sydney.`,
      metric: probe.metricErrors({
        statistic: 'Sum',
        period: Duration.minutes(1),
      }),
      threshold: 1,
      evaluationPeriods: 5,
      datapointsToAlarm: 3,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      // Lambda reports zero errors for every invocation, so a gap means the probe stopped.
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    }).addAlarmAction(notify);
  }
}
