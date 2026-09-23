import { describe, expect, it } from 'vitest';

import { playbookBlockers, presentPlaybook } from './playbook-presentation.js';
import { shippingMethodPlaybook } from './shipping-method-playbook.js';

const version = { ...shippingMethodPlaybook, digest: 'a'.repeat(64) };
describe('playbook presentation', () => {
  it('renders every supported node and preserves approval and verification limits', () => {
    const view = presentPlaybook(version);
    expect(view.steps.map((s) => s.id)).toEqual([
      'eligible',
      'correct-shipping-method',
      'approve',
      'verify-correction',
      'review',
    ]);
    expect(view.approval).toContain('independent');
    expect(view.steps[3]?.description).toContain(
      'Provider acceptance alone is not verified success',
    );
    expect(view.provenance.kind).toBe('pilot');
  });
  it('blocks unsupported capabilities without inventing a compatible system', () => {
    const view = presentPlaybook({
      ...version,
      ir: {
        ...version.ir,
        action: { ...version.ir.action, capability: 'unknown.write' },
      },
    });
    expect(view.compatible).toBe(false);
    expect(view.systems).toEqual([]);
    expect(view.blockers[0]).toContain('not supported');
  });
  it('blocks unsupported capability versions and target kinds', () => {
    expect(
      playbookBlockers({
        ...version,
        ir: {
          ...version.ir,
          action: { ...version.ir.action, capabilityVersion: '1' },
        },
      }),
    ).toHaveLength(1);
    expect(
      playbookBlockers({
        ...version,
        ir: {
          ...version.ir,
          action: { ...version.ir.action, targetKind: 'product' },
        },
      }),
    ).toHaveLength(1);
  });
});
