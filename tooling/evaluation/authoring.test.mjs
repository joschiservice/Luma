import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { ModelGatewayError } from '@luma/platform';

import {
  differences,
  evaluateAuthoring,
  referenceContent,
} from './authoring.mjs';

const corpus = JSON.parse(
  await readFile(
    new URL('./fixtures/authoring-corpus.json', import.meta.url),
    'utf8',
  ),
);

/**
 * A deterministic model: answers each case with `answer(reference)` and applies the output parser
 * like the gateway does. Records every request for inspection.
 */
function fakeModel(answer) {
  const requests = [];

  return {
    requests,
    gateway: {
      async generate(_trace, request) {
        requests.push(request);
        const prompt = request.messages[1].content;
        const item = corpus.cases.find((entry) =>
          prompt.includes(entry.prompt),
        );
        const content = answer(referenceContent(item.reference), item.id);
        let output;
        try {
          output = request.output.parse({
            content,
            steps: [],
            assumptions: [],
            questions: [],
          });
        } catch {
          throw new ModelGatewayError('invalid_output');
        }

        return {
          output,
          toolCalls: [],
          metadata: {
            inputTokens: 10,
            outputTokens: 5,
            costUsd: null,
            adapter: 'bedrock',
            model: 'fake-model',
            latencyMs: 1,
          },
        };
      },
    },
  };
}

test('a model that reproduces every reference yields only valid, equivalent drafts', async () => {
  const model = fakeModel((reference) => reference);
  const report = await evaluateAuthoring(corpus, { gateway: model.gateway });
  assert.equal(report.cases.length, 6);
  assert.deepEqual(
    report.cases.filter((item) => !item.valid || !item.equivalent),
    [],
  );
  assert.equal(report.validDraftRate, 1);
  assert.equal(report.equivalenceRate, 1);
  assert.deepEqual(report.route, {
    profile: 'authoring',
    adapter: 'bedrock',
    model: 'fake-model',
  });
  assert.equal(model.requests.length, 6);
  for (const request of model.requests) {
    assert.equal(request.profile, 'authoring');
    assert.deepEqual(request.dataPolicy, {
      classification: 'sensitive',
      region: 'AU',
      zeroDataRetention: true,
    });
  }
  assert.deepEqual(
    await evaluateAuthoring(corpus, { gateway: fakeModel((r) => r).gateway }),
    report,
  );
});

test('uninstalled actions and structural drift are measured, not trusted', async () => {
  const model = fakeModel((reference, id) => {
    if (id === 'replenishment')
      return {
        ...reference,
        steps: reference.steps.map((step) =>
          step.kind === 'capability'
            ? { ...step, capability: 'payments.refund.create' }
            : step,
        ),
      };
    if (id === 'margin-check')
      return {
        ...reference,
        steps: reference.steps.filter((step) => step.kind !== 'condition'),
      };

    return reference;
  });
  const report = await evaluateAuthoring(corpus, { gateway: model.gateway });
  const byId = Object.fromEntries(report.cases.map((item) => [item.id, item]));

  assert.equal(byId.replenishment.valid, false);
  assert.equal(byId.replenishment.outcome, 'partial');
  assert.equal(byId.replenishment.attempts, 3);
  assert.deepEqual(byId.replenishment.differences, [
    'capabilities: expected ["procurement.purchase-order.create@1"], got ["@"]',
  ]);
  assert.equal(byId['margin-check'].valid, true);
  assert.equal(byId['margin-check'].equivalent, false);
  assert.equal(report.validDraftRate, 5 / 6);
  assert.equal(report.equivalenceRate, 4 / 6);
  assert.deepEqual(
    differences(
      referenceContent(corpus.cases[1].reference),
      referenceContent(corpus.cases[1].reference),
    ),
    [],
  );
});

test('model failures count as invalid drafts', async () => {
  const report = await evaluateAuthoring(corpus, {
    gateway: {
      async generate() {
        throw new ModelGatewayError('timeout');
      },
    },
  });
  assert.equal(report.validDraftRate, 0);
  assert.deepEqual(
    report.cases.map((item) => [item.outcome, item.failure]),
    corpus.cases.map(() => ['failed', 'timeout']),
  );
});
