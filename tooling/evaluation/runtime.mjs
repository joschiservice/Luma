import assert from 'node:assert/strict';

import { createJtlConnector } from '@luma/app-jtl';
import { createShopifyConnector } from '@luma/app-shopify';
import { createCapabilityRuntime } from '@luma/connections/adapters';
import { createShippingMethodEffects } from '@luma/connections/composition';
import {
  createActionAdmission,
  createExecutionService,
  parseAction,
  parseAdmissionReference,
  parseEvidence,
  parseVerification,
} from '@luma/execution/composition';
import { makeTenantContext } from '@luma/identity/composition';
import { createPolicyService } from '@luma/policies/composition';
import {
  activationRequestSchema,
  compilePlaybook,
  createPlaybookService,
  parsePlaybookSnapshot,
  playbookHash,
} from '@luma/resolution/composition';

import { advanceRun, dispatch, mutate } from '../../apps/simulator/dist/run.js';
import { createTransport } from '../../packages/simulator/core/dist/index.js';
import { createState } from './state.mjs';

/** Builds the production interpreter and adapters around a serialized evaluation checkpoint. */
export function createWorker(
  checkpoint,
  fixture,
  ledger,
  observations,
  violations,
) {
  const { incident } = fixture;
  const { action } = incident;
  const state = createState(checkpoint.persistence);
  const provider = checkpoint.provider;
  const now = () => new Date(provider.clock.now);
  const id = () =>
    `00000000-0000-4000-8000-${String(++checkpoint.sequence).padStart(12, '0')}`;
  const context = (tenant = action.tenantId, user = action.proposedBy.id) =>
    makeTenantContext(
      { userId: user, sessionId: 'evaluation' },
      {
        id: tenant,
        name: 'Evaluation',
        slug: 'evaluation',
        status: 'active',
        dataRegion: 'EU',
      },
      {
        id: `membership:${user}`,
        organizationId: tenant,
        userId: user,
        role: 'owner',
      },
      'evaluation',
    );
  const actor = context();
  const refreshContext = async (c) => c;
  const recordObservations = async (batch) => {
    observations.push(structuredClone(batch));
  };
  const transport = (instance) =>
    createTransport(async (request) => {
      if (
        instance === 'shopify' &&
        request.method === 'POST' &&
        !/^\s*(query\b|\{)/.test(JSON.parse(request.body).query ?? '')
      ) {
        violations.push({ kind: 'unexpected-shopify-operation' });
        throw new Error('Unexpected Shopify operation');
      }
      if (
        request.method !== 'GET' &&
        !(instance === 'shopify' && request.method === 'POST')
      ) {
        const expected =
          fixture.expected.providerWrites[checkpoint.writeRequests++];
        const actual = {
          instance,
          method: request.method,
          path: new URL(request.url).pathname,
          body: JSON.parse(request.body),
        };
        if (!expected || !isEqual(actual, expected)) {
          violations.push({ kind: 'unexpected-provider-write', actual });
          throw new Error('Unexpected provider write');
        }
      }

      return dispatch(provider, instance, request);
    });
  const jtl = createJtlConnector({
    tenantId: action.tenantId,
    connectionId: action.connectionId,
    connection: {
      kind: 'onprem',
      baseUrl: 'https://jtl.synthetic.invalid/api/eazybusiness/',
      appId: 'LumaEvaluation',
      appVersion: '1',
      challengeCode: 'synthetic',
      apiKey: async () => 'synthetic',
    },
    shippingMethodActions: true,
    fetch: transport('jtl'),
    now,
    id,
    recordObservations,
  });
  const shopify = createShopifyConnector({
    tenantId: action.tenantId,
    connectionId: incident.shopifyConnectionId,
    shop: 'evaluation.myshopify.com',
    accessToken: async () => 'synthetic',
    fetch: transport('shopify'),
    now,
    id,
    recordObservations,
  });
  for (const connector of [jtl, shopify]) {
    for (const [capability, handler] of Object.entries(
      connector.capabilities,
    )) {
      const original = handler.run;
      handler.run = async (invocation, input) => {
        const call = {
          tenantId: invocation.tenant.tenantId,
          connectionId: invocation.connectionId,
          capability,
          version: handler.descriptor.version,
          input: structuredClone(input),
          ...(invocation.idempotencyKey
            ? { idempotencyKey: invocation.idempotencyKey }
            : {}),
        };
        const expected = fixture.expected.calls[ledger.length];
        ledger.push({ ...call, at: now().toISOString() });
        if (!isEqual(call, expected)) {
          violations.push({
            kind: 'unexpected-capability-call',
            actual: call,
            expected: expected ?? null,
          });
          throw new Error('Unexpected capability call');
        }
        if (
          capability === 'orders.shipping-method.read' &&
          checkpoint.writeRequests > 0 &&
          !checkpoint.verificationFaultApplied
        ) {
          checkpoint.verificationFaultApplied = true;
          advanceRun(provider, fixture.controls.verificationDelayMs ?? 0);
          if (fixture.controls.changeBeforeVerification)
            mutate(provider, 'jtl', {
              kind: 'shipping-method',
              id: incident.mapping.order.externalId,
              shippingMethodId: '9',
            });
        }

        return original(invocation, input);
      };
    }
  }
  const capabilities = createCapabilityRuntime({
    resolve: async (c, connectionId) =>
      c.tenantId === action.tenantId
        ? ([jtl, shopify].find((c) => c.id === connectionId) ?? null)
        : null,
    record: async (event) => {
      (checkpoint.capabilityEvents ??= []).push(structuredClone(event));
    },
  });
  const registry = createShippingMethodEffects(capabilities, {
    now,
    map: async (c, intent) =>
      c.tenantId === action.tenantId &&
      intent.connectionId === action.connectionId &&
      intent.target.id === action.target.id
        ? incident.mapping
        : null,
    checkPreconditions: async () =>
      incident.authority.authoritative && incident.diagnosis.status === 'ready',
  });
  const policies = createPolicyService({
    repository: state.policies,
    appendEvidence: async (event) => {
      (checkpoint.policyEvidence ??= []).push(structuredClone(event));
    },
    refreshContext,
    now,
    id,
  });
  const execution = createExecutionService({
    repository: {
      ...state.execution,
      finish: async (...args) => {
        if (fixture.controls.crashBeforeCompletion && !checkpoint.crashed) {
          checkpoint.crashed = true;
          throw new Error(
            'Injected worker interruption before completion persistence',
          );
        }

        return state.execution.finish(...args);
      },
    },
    policies,
    registry,
    refreshContext,
    now,
    id,
    parse: parseAction,
    parseVerification,
    parseEvidence,
    audit: {
      append: async (entry) => {
        checkpoint.audit.push(structuredClone(entry));
      },
    },
  });
  const admission = createActionAdmission({
    repository: state.provisioning,
    execution,
    refreshContext,
    now,
    parseAction,
    parseReference: parseAdmissionReference,
    eligible: async (c, step) =>
      c.tenantId === action.tenantId &&
      step.incidentId === incident.id &&
      step.diagnosisRevision === incident.diagnosis.revision &&
      incident.diagnosis.status === 'ready',
  });
  const playbooks = createPlaybookService({
    store: state.store,
    provisioning: state.provisioning,
    admission,
    refreshContext,
    now,
    compile: compilePlaybook,
    parseActivation: (input) => activationRequestSchema.parse(input),
    parseSnapshot: parsePlaybookSnapshot,
    parseAction,
    hash: playbookHash,
  });

  return {
    actor,
    context,
    playbooks,
    policies,
    capabilities,
    state,
    adapters: { jtl: jtl.adapterVersion, shopify: shopify.adapterVersion },
  };
}

function isEqual(actual, expected) {
  try {
    assert.deepEqual(actual, expected);

    return true;
  } catch {
    return false;
  }
}
