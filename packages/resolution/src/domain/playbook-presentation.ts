import type { PlaybookVersion } from './playbook.js';

/** States the compatibility and capability prerequisites for activation. */
export function playbookBlockers(version: PlaybookVersion): string[] {
  const reasons: string[] = [];
  if (
    version.compatibility.interpreter !== 'resolution-playbook/0' ||
    version.compatibility.admission !== 1
  )
    reasons.push(
      'This version needs another interpreter. Ask an administrator to publish a compatible version.',
    );
  if (
    version.ir.action.capability !== 'orders.shipping-method.write' ||
    version.ir.action.capabilityVersion !== '0' ||
    version.ir.action.targetKind !== 'order'
  )
    reasons.push(
      'This capability is not supported for activation. Publish a version using orders.shipping-method.write@0 for orders.',
    );

  return reasons;
}

/** Converts the linear representation into readable steps without implying business resolution. */
export function presentPlaybook(version: PlaybookVersion) {
  const ir = version.ir;
  const label = (value: string) =>
    value
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replaceAll('_', ' ')
      .toLowerCase();
  const binding = (value: (typeof ir.action.parameters)[string]) =>
    value.source === 'literal'
      ? JSON.stringify(value.value)
      : `${label(value.field)} from ${value.source}`;
  const approval =
    ir.approval.mode === 'required' || ir.action.minimumRisk !== 'low'
      ? 'An independent owner or administrator must approve each proposed change. Activation does not approve an action.'
      : 'Current policy decides whether a person must approve each proposed change. Activation does not bypass policy.';
  const blockers = playbookBlockers(version);

  return {
    version: version.version,
    digest: version.digest,
    compatible: blockers.length === 0,
    blockers,
    capability: ir.action.capability,
    capabilityVersion: ir.action.capabilityVersion,
    targetKind: ir.action.targetKind,
    issueType: ir.evidence.kind,
    systems:
      ir.action.capability === 'orders.shipping-method.write'
        ? ['jtl-cloud', 'jtl-onprem']
        : [],
    approval,
    permissions: [ir.action.capability, 'orders.read'],
    provenance: version.provenance,
    representation: JSON.stringify(version.ir, null, 2),
    steps: [
      {
        id: ir.eligibility.id,
        title: 'Check eligibility',
        description: `Apply only when every condition holds, using evidence less than ${ir.evidence.maxAgeSeconds} seconds old.`,
        details: ir.eligibility.all.map((check) =>
          check.field === 'diagnosisReady' && check.equals === true
            ? 'The diagnosis is ready for a proposed correction.'
            : check.field === 'methodMapped' && check.equals === true
              ? 'An approved shipping-method mapping is available.'
              : `${label(check.field)} must equal ${JSON.stringify(check.equals)}.`,
        ),
      },
      {
        id: ir.action.id,
        title: 'Propose the change',
        description:
          ir.action.capability === 'orders.shipping-method.write'
            ? 'Change the shipping method on one order to the mapped method, within the selected connection and order grants.'
            : `Use ${ir.action.capability}@${ir.action.capabilityVersion} on one ${ir.action.targetKind} within the selected connection and resource grants.`,
        details: [
          ...Object.entries(ir.action.parameters).map(
            ([key, value]) => `Set ${label(key)} to ${binding(value)}.`,
          ),
          ...Object.entries(ir.action.expectedPostcondition).map(
            ([key, value]) =>
              `Expected result: ${label(key)} equals ${binding(value)}.`,
          ),
        ],
      },
      {
        id: ir.approval.id,
        title: 'Obtain approval',
        description: approval,
        details: [
          `Minimum risk: ${ir.action.minimumRisk}. Current membership, grants and policy are checked again before dispatch.`,
        ],
      },
      {
        id: ir.verification.id,
        title: 'Verify the result',
        description: `Read the authoritative order and check the expected result within ${ir.verification.maxDurationSeconds} seconds. Provider acceptance alone is not verified success.`,
        details: [
          `Evaluator: ${ir.verification.evaluatorVersion}. One initial verification attempt.`,
          'A verified shipping-method correction does not prove that fulfillment resumed.',
        ],
      },
      {
        id: ir.recovery.id,
        title: 'Recover or escalate',
        description:
          'Reconcile an uncertain change with reads only. Escalate for operator review when the expected result cannot be established.',
        details: [
          'Recovery does not issue another write. Expired evidence cannot authorize a new change.',
        ],
      },
    ],
  };
}
