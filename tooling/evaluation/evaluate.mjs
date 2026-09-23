import assert from 'node:assert/strict';

import { currentPolicyVersion } from '@luma/policies';
import { compilePlaybook, playbookHash } from '@luma/resolution/composition';

import { advanceRun } from '../../apps/simulator/dist/run.js';
import { createWorker } from './runtime.mjs';

/** Evaluates a pinned shipping-correction candidate and retains every scenario failure and trace. */
export async function evaluate(candidate, corpus) {
  const { digest: declaredDigest, ...source } = candidate;
  const version = compilePlaybook(source);
  assert.equal(
    declaredDigest,
    version.digest,
    'Candidate content hash mismatch',
  );
  assert.equal(corpus.schemaVersion, 1);
  assert.ok(
    corpus.version && corpus.scenarios.length > 0,
    'A versioned nonempty corpus is required',
  );
  assert.equal(
    new Set(corpus.scenarios.map((s) => s.id)).size,
    corpus.scenarios.length,
    'Duplicate scenario ID',
  );
  const scenarios = [];
  for (const scenario of corpus.scenarios) {
    const fixture = {
      ...corpus.fixture,
      ...scenario,
      incident: { ...corpus.fixture.incident, ...scenario.incident },
    };
    scenarios.push(await evaluateScenario(version, fixture));
  }

  return {
    schemaVersion: 1,
    passed: scenarios.every((s) => s.passed),
    playbook: {
      definitionId: version.definition.id,
      version: version.version,
      hash: version.digest,
    },
    corpus: { version: corpus.version, hash: playbookHash(corpus) },
    interpreterVersion: version.compatibility.interpreter,
    admissionVersion: version.compatibility.admission,
    capabilityVersions: {
      'orders.read': '0',
      'orders.shipping-method.read': '0',
      'orders.shipping-method.write': '0',
    },
    scenarios,
  };
}

async function evaluateScenario(version, fixture) {
  const calls = [],
    observations = [],
    violations = [],
    outcomes = [];
  let checkpoint = {
    provider: structuredClone(fixture.provider),
    persistence: {},
    sequence: 100,
    writeRequests: 0,
    audit: [],
  };
  let worker;
  let failure;
  try {
    assert.ok(
      fixture.version && fixture.incident.provenance.reference,
      'Fixture version and provenance are required',
    );
    const { incident, controls, expected } = fixture;
    assert.ok(['synthetic', 'historical'].includes(incident.provenance.kind));
    assert.ok(
      incident.authority.reference && incident.diagnosis.cause !== undefined,
    );
    worker = createWorker(checkpoint, fixture, calls, observations, violations);
    await worker.playbooks.publish(worker.actor, omitDigest(version));
    await worker.playbooks.activate(worker.actor, {
      id: incident.activationId,
      definitionId: version.definition.id,
      version: version.version,
      grants: incident.grants,
      policyVersion: currentPolicyVersion,
    });
    for (const request of incident.reads) {
      const result = await worker.capabilities.read(worker.actor, request);
      assert.equal(result.ok, true, 'Incident evidence read failed');
    }
    await worker.playbooks.bind(worker.actor, {
      activationId: incident.activationId,
      incidentId: incident.id,
      diagnosisRevision: incident.diagnosis.revision,
      action: incident.action,
      snapshot: incident.snapshot,
    });
    for (const command of controls.commands) {
      if (command.kind === 'advance') {
        advanceRun(checkpoint.provider, command.ms);
        continue;
      }
      if (command.kind === 'restart') {
        // JSON round-trip drops closures and shared references, just like a worker checkpoint reload.
        checkpoint = JSON.parse(JSON.stringify(checkpoint));
        worker = createWorker(
          checkpoint,
          fixture,
          calls,
          observations,
          violations,
        );
        continue;
      }
      if (command.kind === 'approve' || command.kind === 'reject') {
        const previous = outcomes.at(-1);
        assert.equal(previous.reason, 'approval_required');
        await worker.policies.respond(
          worker.context(incident.action.tenantId, 'reviewer'),
          previous.decisionId,
          command.kind === 'approve' ? 'approved' : 'rejected',
          incident.action.expiresAt,
        );
        continue;
      }
      if (command.kind === 'foreign-tenant') {
        const foreign = worker.context('00000000-0000-4000-8000-000000000099');
        await assert.rejects(
          worker.playbooks.execute(foreign, incident.action.id),
          /Playbook run not found/,
        );
        assert.equal(
          await worker.state.execution.get(
            foreign.tenantId,
            incident.action.id,
          ),
          null,
        );
        const read = await worker.capabilities.read(foreign, incident.reads[0]);
        assert.equal(read.ok, false);
        continue;
      }
      assert.ok(
        ['execute', 'reconcile'].includes(command.kind),
        'Unknown replay command',
      );
      outcomes.push(
        await worker.playbooks[command.kind](worker.actor, incident.action.id),
      );
    }
    assert.deepEqual(violations, [], 'Unexpected capability/provider call');
    assert.deepEqual(
      calls.map((entry) => {
        const call = { ...entry };
        delete call.at;

        return call;
      }),
      expected.calls,
      'Capability sequence mismatch',
    );
    assert.equal(
      checkpoint.writeRequests,
      expected.providerWrites.length,
      'Provider write count mismatch',
    );
    assert.deepEqual(
      outcomes.map((o) => ({ state: o.state, reason: o.reason })),
      expected.outcomes,
      'Outcome sequence mismatch',
    );
    assert.equal(
      checkpoint.provider.jtl.orders.find(
        (o) => o.id === incident.mapping.order.externalId,
      ).shippingMethodId,
      expected.shippingMethodId,
      'Provider postcondition mismatch',
    );
    assert.deepEqual(
      checkpoint.provider.shopify,
      fixture.provider.shopify,
      'Unexpected Shopify mutation',
    );
  } catch (error) {
    failure = error.message;
  }

  return {
    id: fixture.id,
    fixtureVersion: fixture.version,
    fixtureHash: playbookHash(fixture),
    provenance: fixture.incident.provenance,
    passed: !failure,
    ...(failure ? { failure } : {}),
    adapterVersions: worker?.adapters ?? {},
    calls,
    violations,
    outcomes,
    observations,
    checkpoint,
  };
}

function omitDigest(version) {
  const source = { ...version };
  delete source.digest;

  return source;
}
