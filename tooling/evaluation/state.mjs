import assert from 'node:assert/strict';

import { parseAction } from '@luma/execution/composition';
import { playbookHash } from '@luma/resolution/composition';

const copy = (value) => structuredClone(value ?? null);
const key = (...parts) => JSON.stringify(parts);

/** Creates serializable, tenant-scoped persistence for an isolated evaluation worker. */
export function createState(document = {}) {
  const tables = document;
  const table = (name) => (tables[name] ??= {});
  const get = (name, ...parts) => copy(table(name)[key(...parts)]);
  const put = (name, parts, value) => {
    table(name)[key(...parts)] = copy(value);
  };
  const immutable = (name, parts, value) => {
    const prior = get(name, ...parts);
    if (prior) assert.deepEqual(prior, value, `Conflicting ${name}`);
    else put(name, parts, value);

    return copy(value);
  };
  const store = {
    publish: async (c, v) =>
      immutable('versions', [c.tenantId, v.definition.id, v.version], v),
    version: async (c, id, v) => get('versions', c.tenantId, id, v),
    activate: async (c, a) => immutable('activations', [c.tenantId, a.id], a),
    activation: async (c, id) => get('activations', c.tenantId, id),
    bind: async (c, run) => immutable('runs', [c.tenantId, run.id], run),
    run: async (c, id) => get('runs', c.tenantId, id),
    record: async (c, id, outcome) =>
      put(
        'outcomes',
        [c.tenantId, id],
        [...(get('outcomes', c.tenantId, id) ?? []), outcome],
      ),
    outcomes: async (c, id) => get('outcomes', c.tenantId, id) ?? [],
  };
  const provisioning = {
    activate: async (c, artifact) =>
      immutable('artifacts', [c.tenantId, artifact.id, artifact.version], {
        ...artifact,
        digest: playbookHash(artifact),
        active: true,
      }),
    artifact: async (c, id, v) => get('artifacts', c.tenantId, id, v),
    revoke: async (c, id, v) =>
      put('artifacts', [c.tenantId, id, v], {
        ...get('artifacts', c.tenantId, id, v),
        active: false,
      }),
    bind: async (c, step) =>
      immutable('steps', [c.tenantId, step.runId, step.stepId], {
        ...step,
        actionHash: parseAction(step.action).hash,
      }),
    step: async (c, runId, stepId) => get('steps', c.tenantId, runId, stepId),
  };
  const execution = {
    bindIntent: async (action, hash) =>
      immutable('intents', [action.tenantId, action.id], { action, hash }),
    get: async (tenant, id) => get('executions', tenant, id),
    prepare: async (record, event) => {
      if (get('executions', record.tenantId, record.proposalId)) return false;
      put('executions', [record.tenantId, record.proposalId], record);
      put('outbox', [record.tenantId, event.id], event);

      return true;
    },
    finish: async (record, expected, event) => {
      if (
        get('executions', record.tenantId, record.proposalId)?.state !==
        expected
      )
        return false;
      put('executions', [record.tenantId, record.proposalId], record);
      put('outbox', [record.tenantId, event.id], event);

      return true;
    },
    pending: async (tenant, proposal) =>
      Object.values(table('outbox'))
        .filter((e) => e.tenantId === tenant && e.proposalId === proposal)
        .map(copy),
    delivered: async (tenant, id) => {
      delete table('outbox')[key(tenant, id)];
    },
    verification: async (tenant, entry) =>
      put('verifications', [tenant, entry.id, entry.phase], entry),
    failure: async (tenant, entry) =>
      put('failures', [tenant, entry.id], entry),
  };
  const policies = {
    pending: async () => [],
    delivered: async () => undefined,
    saveDecision: async (d) => put('decisions', [d.tenantId, d.id], d),
    findDecision: async (tenant, id) => get('decisions', tenant, id),
    findApproval: async (tenant, proposal, hash, version) =>
      get('approvals', tenant, proposal, hash, version),
    saveApproval: async (a) => {
      const parts = [a.tenantId, a.proposalId, a.actionHash, a.policyVersion];
      const prior = get('approvals', ...parts);
      if (prior) return prior;
      put('approvals', parts, a);

      return copy(a);
    },
  };

  return { document, store, provisioning, execution, policies };
}
