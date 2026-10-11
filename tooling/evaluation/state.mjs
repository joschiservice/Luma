import assert from 'node:assert/strict';

import { parseAction } from '@luma/execution/composition';
import { playbookHash } from '@luma/resolution/composition';

// Each fake is typed as the dependency its service accepts, so an interface change fails
// `pnpm typecheck:tooling` instead of silently changing evaluation behavior.
/** @typedef {Parameters<typeof import('@luma/resolution/composition').createPlaybookService>[0]} PlaybookDependencies */
/** @typedef {PlaybookDependencies['store']} PlaybookStore */
/** @typedef {PlaybookDependencies['provisioning'] & Parameters<typeof import('@luma/execution/composition').createActionAdmission>[0]['repository']} ProvisioningRepository */
/** @typedef {Parameters<typeof import('@luma/execution/composition').createExecutionService>[0]['repository']} ExecutionRepository */
/** @typedef {Parameters<typeof import('@luma/policies/composition').createPolicyService>[0]['repository']} PolicyRepository */
/** @typedef {NonNullable<Awaited<ReturnType<ProvisioningRepository['artifact']>>>} ActivatedArtifact */
/**
 * @typedef {{
 *   versions: Parameters<PlaybookStore['publish']>[1],
 *   activations: Parameters<PlaybookStore['activate']>[1],
 *   runs: Parameters<PlaybookStore['bind']>[1],
 *   outcomes: Parameters<PlaybookStore['record']>[2][],
 *   artifacts: ActivatedArtifact,
 *   steps: NonNullable<Awaited<ReturnType<ProvisioningRepository['step']>>>,
 *   intents: { action: Parameters<ExecutionRepository['bindIntent']>[0], hash: string },
 *   executions: Parameters<ExecutionRepository['prepare']>[0],
 *   outbox: Parameters<ExecutionRepository['prepare']>[1],
 *   verifications: Parameters<ExecutionRepository['verification']>[1],
 *   failures: Parameters<ExecutionRepository['failure']>[1],
 *   decisions: Parameters<PolicyRepository['saveDecision']>[0],
 *   approvals: Parameters<PolicyRepository['saveApproval']>[0],
 * }} Records
 */
/** @typedef {{ [K in keyof Records]?: Record<string, Records[K]> }} Tables */

/**
 * Builds a record key from its identifying parts.
 * @param {...unknown} parts
 */
const key = (...parts) => JSON.stringify(parts);

/**
 * Checks the fields every action artifact carries before the fake stores it, as the database
 * store's schema does.
 * @param {unknown} value
 * @returns {value is Omit<ActivatedArtifact, 'digest' | 'active'>}
 */
function isArtifact(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'version' in value &&
    typeof value.version === 'string'
  );
}

/**
 * Creates serializable, tenant-scoped persistence for an isolated evaluation worker.
 * @param {Tables} [document] persisted tables from an earlier worker
 */
export function createState(document = {}) {
  const tables = document;
  /**
   * Returns a table, creating it on first use.
   * @template {keyof Records} K
   * @param {K} name
   * @returns {Record<string, Records[K]>}
   */
  const table = (name) => {
    /** @type {Tables[K]} */
    const existing = tables[name];
    if (existing) return existing;
    /** @type {Record<string, Records[K]>} */
    const created = {};
    // Tables[K] is this record type by definition; TypeScript cannot relate a mapped type
    // through a generic key.
    tables[name] = /** @type {Tables[K]} */ (created);

    return created;
  };
  /**
   * Reads a copy of a stored record, or null.
   * @template {keyof Records} K
   * @param {K} name
   * @param {...unknown} parts
   * @returns {Records[K] | null}
   */
  const get = (name, ...parts) => {
    const value = table(name)[key(...parts)];

    return value === undefined ? null : structuredClone(value);
  };
  /**
   * Stores a copy of a record.
   * @template {keyof Records} K
   * @param {K} name
   * @param {unknown[]} parts
   * @param {Records[K]} value
   */
  const put = (name, parts, value) => {
    table(name)[key(...parts)] = structuredClone(value);
  };
  /**
   * Writes a record once; a later write must be identical.
   * @template {keyof Records} K
   * @param {K} name
   * @param {unknown[]} parts
   * @param {Records[K]} value
   * @returns {Records[K]}
   */
  const immutable = (name, parts, value) => {
    const prior = get(name, ...parts);
    if (prior) assert.deepEqual(prior, value, `Conflicting ${name}`);
    else put(name, parts, value);

    return structuredClone(value);
  };
  /** @type {PlaybookStore} */
  const store = {
    publish: async (c, v) => {
      immutable('versions', [c.tenantId, v.definition.id, v.version], v);
    },
    version: async (c, id, v) => get('versions', c.tenantId, id, v),
    activate: async (c, a) => {
      immutable('activations', [c.tenantId, a.id], a);
    },
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
  /** @type {ProvisioningRepository} */
  const provisioning = {
    activate: async (c, artifact) => {
      assert.ok(isArtifact(artifact), 'Invalid action artifact');

      return immutable(
        'artifacts',
        [c.tenantId, artifact.id, artifact.version],
        { ...artifact, digest: playbookHash(artifact), active: true },
      );
    },
    artifact: async (c, id, v) => get('artifacts', c.tenantId, id, v),
    revoke: async (c, id, v) => {
      const artifact = get('artifacts', c.tenantId, id, v);
      if (artifact)
        put('artifacts', [c.tenantId, id, v], { ...artifact, active: false });
    },
    bind: async (c, step) => {
      immutable('steps', [c.tenantId, step.runId, step.stepId], {
        ...step,
        actionHash: parseAction(step.action).hash,
      });
    },
    step: async (c, runId, stepId) => get('steps', c.tenantId, runId, stepId),
  };
  /** @type {ExecutionRepository} */
  const execution = {
    bindIntent: async (action, hash) => {
      immutable('intents', [action.tenantId, action.id], { action, hash });
    },
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
        .map((e) => structuredClone(e)),
    delivered: async (tenant, id) => {
      delete table('outbox')[key(tenant, id)];
    },
    verification: async (tenant, entry) =>
      put('verifications', [tenant, entry.id, entry.phase], entry),
    failure: async (tenant, entry) =>
      put('failures', [tenant, entry.id], entry),
  };
  /** @type {PolicyRepository} */
  const policies = {
    // Evaluations use the platform default: no workspace settings row, so no approval
    // override, and a different person must approve.
    workspacePolicy: async () => ({
      revision: 0,
      required: false,
      requireIndependentApproval: true,
    }),
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

      return structuredClone(a);
    },
  };

  return { document, store, provisioning, execution, policies };
}
