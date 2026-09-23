import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { shippingMethodPlaybook } from '@luma/resolution';
import { compilePlaybook } from '@luma/resolution/composition';

import { captureIncident } from './capture.mjs';
import { evaluate } from './evaluate.mjs';

const read = async (name) =>
  JSON.parse(
    await readFile(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8'),
  );
const candidate = await read('candidate');
const corpus = await read('corpus');
const one = () => ({
  ...structuredClone(corpus),
  scenarios: [structuredClone(corpus.scenarios[0])],
});

test('the pinned candidate matches the shipped Playbook definition', () => {
  assert.deepEqual(candidate, compilePlaybook(shippingMethodPlaybook));
});

test('release corpus passes with byte-identical traces across fresh workers', async () => {
  const first = await evaluate(candidate, corpus);
  assert.equal(
    first.passed,
    true,
    JSON.stringify(first.scenarios.filter((s) => !s.passed)),
  );
  assert.equal(
    JSON.stringify(first),
    JSON.stringify(await evaluate(candidate, corpus)),
  );
  for (const scenario of first.scenarios) {
    assert.match(scenario.fixtureHash, /^[a-f0-9]{64}$/);
    assert.ok(scenario.observations.length >= 2);
    assert.equal(scenario.violations.length, 0);
  }
});

test('an extra write fails closed even when execution absorbs the connector error', async () => {
  const changed = one();
  changed.scenarios[0].expected.calls.splice(2, 1);
  const report = await evaluate(candidate, changed);
  assert.equal(report.passed, false);
  assert.equal(
    report.scenarios[0].violations[0].kind,
    'unexpected-capability-call',
  );
  assert.equal(report.scenarios[0].checkpoint.writeRequests, 0);
});

test('wrong provider parameters fail before mutation', async () => {
  const changed = one();
  changed.scenarios[0].expected.providerWrites[0].body.shippingMethodId = '9';
  const report = await evaluate(candidate, changed);
  assert.equal(report.passed, false);
  assert.equal(
    report.scenarios[0].violations[0].kind,
    'unexpected-provider-write',
  );
  assert.equal(
    report.scenarios[0].checkpoint.provider.jtl.orders[0].shippingMethodId,
    '7',
  );
});

test('missing calls, wrong targets, wrong ordering and incorrect outcomes fail the gate', async () => {
  for (const change of [
    (s) => s.expected.calls.push(s.expected.calls[0]),
    (s) => {
      s.expected.calls[2].input.order.externalId = '10';
    },
    (s) => s.expected.calls.reverse(),
    (s) => {
      s.expected.outcomes[1].reason = 'verification_failed';
    },
  ]) {
    const changed = one();
    change(changed.scenarios[0]);
    assert.equal((await evaluate(candidate, changed)).passed, false);
  }
});

test('candidate hash and corpus identity are enforced', async () => {
  await assert.rejects(
    evaluate({ ...candidate, digest: '0'.repeat(64) }, corpus),
    /hash mismatch/,
  );
  await assert.rejects(
    evaluate(candidate, { ...corpus, scenarios: [] }),
    /nonempty corpus/,
  );
  await assert.rejects(
    evaluate(candidate, {
      ...corpus,
      scenarios: [corpus.scenarios[0], corpus.scenarios[0]],
    }),
    /Duplicate/,
  );
  const source = structuredClone(candidate);
  delete source.digest;
  source.ir.verification.maxDurationSeconds = 1;
  assert.equal((await evaluate(compilePlaybook(source), corpus)).passed, false);
});

test('historical capture preserves source facts and replays the exact candidate', async () => {
  const base = one();
  const fixture = {
    ...base.fixture,
    ...base.scenarios[0],
    incident: base.fixture.incident,
  };
  const history = {
    reference: 'test:retained-incident',
    playbook: candidate,
    actionSequence: [fixture.incident.action],
    observations: fixture.incident.snapshot.evidence.observations,
    outcome: { state: 'verified' },
  };
  const captured = captureIncident({
    corpusVersion: 'historical-test/1',
    fixture,
    history,
  });
  assert.deepEqual(captured.scenarios[0].incident.history, history);
  assert.equal((await evaluate(candidate, captured)).passed, true);
  const invalid = structuredClone(history);
  invalid.actionSequence[0].tenantId = '00000000-0000-4000-8000-000000000099';
  assert.throws(
    () => captureIncident({ corpusVersion: '1', fixture, history: invalid }),
    /tenant/,
  );
});

test('CLI persists traceable failures and exits nonzero', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-evaluation-'));
  try {
    const changed = one();
    changed.scenarios[0].expected.calls = [];
    const path = join(directory, 'corpus.json');
    const output = join(directory, 'report.json');
    await writeFile(path, JSON.stringify(changed));
    const child = spawnSync(
      process.execPath,
      ['tooling/evaluation/cli.mjs', '--corpus', path, '--output', output],
      { encoding: 'utf8' },
    );
    assert.equal(child.status, 1, child.stderr);
    const report = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(report.passed, false);
    assert.equal(report.playbook.hash, candidate.digest);
    assert.ok(report.scenarios[0].failure);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
