import assert from 'node:assert/strict';

import { parseAction } from '@luma/execution/composition';
import {
  compilePlaybook,
  parsePlaybookSnapshot,
  playbookHash,
} from '@luma/resolution/composition';

/** Captures reconstructed incident inputs and retained results as a versioned replay corpus. */
export function captureIncident(input) {
  const { fixture, history, corpusVersion } = structuredClone(input);
  assert.ok(
    corpusVersion && fixture.id && fixture.version,
    'Corpus and fixture versions are required',
  );
  assert.ok(
    history.reference &&
      history.observations.length &&
      history.actionSequence.length &&
      history.outcome,
    'Retained incident actions, observations, outcome and source reference are required',
  );
  const { digest, ...source } = history.playbook;
  const version = compilePlaybook(source);
  assert.equal(
    digest,
    version.digest,
    'Historical Playbook content hash mismatch',
  );
  parsePlaybookSnapshot(fixture.incident.snapshot, version);
  const { action } = parseAction(fixture.incident.action);
  for (const entry of history.actionSequence) {
    const historical = parseAction(entry).action;
    assert.equal(
      historical.tenantId,
      action.tenantId,
      'Historical actions cross tenant boundaries',
    );
  }
  assert.ok(
    history.actionSequence.some(
      (entry) => playbookHash(entry) === playbookHash(action),
    ),
    'Replay action is absent from retained history',
  );
  assert.ok(
    fixture.incident.mapping &&
      fixture.incident.authority.reference &&
      fixture.incident.diagnosis.cause !== undefined,
    'Mappings, authority and diagnosis are required',
  );
  assert.ok(
    fixture.expected.calls &&
      fixture.expected.providerWrites &&
      fixture.expected.outcomes.length,
    'Reviewed expectations are required',
  );
  assert.ok(
    Number.isFinite(fixture.provider.now),
    'Initial provider state and clock are required',
  );
  fixture.incident.provenance = {
    kind: 'historical',
    reference: history.reference,
    sourceHash: playbookHash(history),
    playbookHash: digest,
  };
  fixture.incident.history = history;

  return {
    schemaVersion: 1,
    version: corpusVersion,
    fixture: { incident: {} },
    scenarios: [fixture],
  };
}
