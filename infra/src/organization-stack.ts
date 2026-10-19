import { Stack, type StackProps } from 'aws-cdk-lib';
import { CfnPolicy } from 'aws-cdk-lib/aws-organizations';
import type { Construct } from 'constructs';

import { approvedRegions } from './settings.js';

// Actions of global services, which resolve to us-east-1 or carry no region. This follows
// AWS's example policy for denying access outside requested Regions.
const globalActions = [
  'acm:*',
  'aws-marketplace-management:*',
  'aws-marketplace:*',
  'aws-portal:*',
  'budgets:*',
  'ce:*',
  'cloudfront:*',
  'config:*',
  'cur:*',
  'directconnect:*',
  'ec2:DescribeRegions',
  'ec2:DescribeTransitGateways',
  'ec2:DescribeVpnGateways',
  'fms:*',
  'globalaccelerator:*',
  'health:*',
  'iam:*',
  'importexport:*',
  'kms:*',
  'networkmanager:*',
  'organizations:*',
  'pricing:*',
  'route53-recovery-cluster:*',
  'route53-recovery-control-config:*',
  'route53-recovery-readiness:*',
  'route53:*',
  'route53domains:*',
  's3:GetAccountPublic*',
  's3:ListAllMyBuckets',
  's3:ListMultiRegionAccessPoints',
  's3:PutAccountPublic*',
  'shield:*',
  'sts:*',
  'support:*',
  'trustedadvisor:*',
  'waf-regional:*',
  'waf:*',
  'wafv2:*',
  'wellarchitected:*',
];

export interface OrganizationStackProps extends StackProps {
  /** Organizational unit or account IDs the policy applies to; empty creates it unattached. */
  readonly targetIds: readonly string[];
}

/**
 * Organization guardrails, deployed in the management account. The service control policy
 * denies regional actions outside the approved Australian regions in the workload accounts,
 * so no resource or processing can start elsewhere by mistake. It never applies to the
 * management account itself. Service control policies must be enabled in the organization.
 */
export class OrganizationStack extends Stack {
  constructor(scope: Construct, id: string, props: OrganizationStackProps) {
    super(scope, id, props);

    new CfnPolicy(this, 'ApprovedRegionsOnly', {
      name: 'luma-approved-regions-only',
      description:
        'Denies regional AWS actions outside the regions approved for the AU cell.',
      type: 'SERVICE_CONTROL_POLICY',
      targetIds: [...props.targetIds],
      content: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'DenyOutsideApprovedRegions',
            Effect: 'Deny',
            NotAction: globalActions,
            Resource: '*',
            Condition: {
              StringNotEquals: { 'aws:RequestedRegion': approvedRegions },
            },
          },
        ],
      },
    });
  }
}
