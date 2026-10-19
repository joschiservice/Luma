import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';

import cdk from '../cdk.json' with { type: 'json' };
import { buildLumaApp } from './luma-app.js';

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
