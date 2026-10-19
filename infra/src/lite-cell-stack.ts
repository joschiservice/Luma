import { fileURLToPath } from 'node:url';

import {
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
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

import { backupBucketName, type FoundationStack } from './foundation-stack.js';
import { acknowledge, acknowledgeWildcards, nagAccount } from './nag.js';
import type { CellSettings } from './settings.js';

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
    acknowledge(role, [
      {
        id: 'AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore]',
        reason:
          'The AWS managed SSM core policy is the documented minimum for Session Manager and Run Command.',
      },
    ]);
    acknowledgeWildcards(
      role,
      'Limited to this stage: its parameter path, its backup prefix and instances tagged for this cell. Registry login and volume lookup have no resource ARN.',
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
      ...(settings.domain ? { DOMAIN: settings.domain } : {}),
    };
    const parameters = Object.entries(hostSettings).map(
      ([name, value]) =>
        new ssm.StringParameter(this, `Host${name}`, {
          parameterName: `${parameterPath}/host/${name}`,
          stringValue: value,
        }),
    );

    // User data only prepares the host and fetches the host files; the deploy command does the
    // rest. It changes only when the data volume does, and then replaces the instance so the
    // new host attaches the new volume. Updating host files never restarts the instance.
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euo pipefail',
      'mkdir -p /etc/luma',
      `printf '%s\\n' 'LUMA_STAGE=${stage}' 'AWS_REGION=${this.region}' 'LUMA_DATA_VOLUME_ID=${data.volumeId}' > /etc/luma/host.env`,
      `bundle=$(aws ssm get-parameter --region ${this.region} --name ${parameterPath}/host/BUNDLE_URL --query Parameter.Value --output text)`,
      'aws s3 cp "$bundle" /tmp/luma-host-files.zip',
      'rm -rf /opt/luma && mkdir -p /opt/luma && python3 -m zipfile -e /tmp/luma-host-files.zip /opt/luma',
      'bash /opt/luma/bin/luma-host-setup',
    );

    const host = new ec2.Instance(this, 'Host', {
      vpc,
      vpcSubnets: { subnets: [subnet] },
      instanceType: new ec2.InstanceType(settings.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      role,
      securityGroup: ingress,
      userData,
      userDataCausesReplacement: true,
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
    for (const parameter of parameters) host.node.addDependency(parameter);
    acknowledge(host, [
      {
        id: 'AwsSolutions::AwsSolutions-EC28',
        reason:
          'Basic monitoring suffices for one host; detailed monitoring adds cost.',
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
    const notify = new actions.SnsAction(foundation.alerts);
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

    if (settings.domain) {
      const zone = new route53.PublicHostedZone(this, 'Zone', {
        zoneName: settings.domain,
      });
      new route53.ARecord(this, 'AppRecord', {
        zone,
        recordName: `au.app.${settings.domain}`,
        target: route53.RecordTarget.fromIpAddresses(address.attrPublicIp),
        ttl: Duration.minutes(5),
      });
      new CfnOutput(this, 'NameServers', {
        description: 'Delegate the domain to these name servers.',
        value: Fn.join(', ', zone.hostedZoneNameServers ?? []),
      });
    }

    new CfnOutput(this, 'PublicAddress', { value: address.attrPublicIp });
    new CfnOutput(this, 'InstanceId', { value: host.instanceId });
  }
}
