import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runExampleCode } from '../application/draft-tests.js';
import type { CodeRunner, CodeStep } from '../domain/code-step.js';
import type { StepReply } from '../domain/draft-test.js';
import type { PlaybookScalar } from '../domain/playbook.js';
import { createWasmtimeRunner } from './code/runner.js';
import { checkCodeStep } from './code/schema.js';

interface Corpus {
  step: CodeStep;
  cases: {
    id: string;
    input: unknown;
    now: string;
    replies: { grant: string; value: Record<string, PlaybookScalar> }[];
    expected: Record<string, PlaybookScalar>;
  }[];
}

const corpus: Corpus = JSON.parse(
  await readFile(
    new URL(
      '../../../../tooling/evaluation/fixtures/code-corpus.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const directory =
  process.env.LUMA_CODE_RUNTIME_DIR ??
  fileURLToPath(new URL('../../../../.luma/code-runtime/', import.meta.url));

class Pending extends Error {
  constructor(readonly grant: string) {
    super(grant);
  }
}

/**
 * Executes plain JavaScript Code Step source in-process. Synchronous guest requests are replayed:
 * an unknown request stops the guest, is answered by the host, and the guest runs again.
 */
const javascriptRunner: CodeRunner = {
  async run(step, input, options) {
    const main = new Function(
      'input',
      'luma',
      `${step.source}\nreturn main(input, luma);`,
    );
    const answers: unknown[] = [];
    for (;;) {
      let index = 0;
      try {
        const values = main(structuredClone(input), {
          request(grant: string) {
            if (index < answers.length) return answers[index++];
            throw new Pending(grant);
          },
        });

        return {
          values,
          telemetry: {
            runtime: step.runtime,
            artifactDigest: step.artifactDigest,
            inputDigest: createHash('sha256')
              .update(JSON.stringify(input))
              .digest('hex'),
            wallTimeMs: 0,
            requests: answers.length,
            outcome: 'completed',
          },
        };
      } catch (error) {
        if (!(error instanceof Pending)) throw error;
        answers.push(await options.request(error.grant));
      }
    }
  },
};

const step = checkCodeStep(corpus.step);
// The corpus grants one read; a draft declares it right after the Code Step.
const version = {
  steps: [
    step,
    {
      id: 'stock',
      kind: 'read' as const,
      source: 'inventory',
      fields: { available: 'number' as const },
    },
  ],
};

async function replay(runner: CodeRunner, fixture: Corpus['cases'][number]) {
  const replies: Record<string, StepReply> = Object.fromEntries(
    fixture.replies.map((reply) => [
      reply.grant,
      { kind: 'read', values: reply.value },
    ]),
  );

  return runExampleCode(
    { runner, now: fixture.now, signal: new AbortController().signal },
    version,
    step,
    fixture.input,
    replies,
  );
}

function expectCorpusValues(
  runs: Awaited<ReturnType<typeof replay>>[],
  fixture: Corpus['cases'][number],
) {
  const [first, second] = runs;
  expect(first!.result).toMatchObject({
    state: 'completed',
    values: fixture.expected,
    telemetry: { outcome: 'completed', verifiedActions: 0 },
  });
  expect(first!.requests.map((request) => request.stepId)).toEqual(
    fixture.replies.map((reply) => reply.grant),
  );
  expect(second!.result.values).toEqual(first!.result.values);
  expect(second!.result.telemetry.inputDigest).toBe(
    first!.result.telemetry.inputDigest,
  );
}

describe('replenishment code corpus through the draft test code path', () => {
  it.each(corpus.cases)(
    'computes the evaluate:code values for $id with the in-process runner',
    async (fixture) => {
      expectCorpusValues(
        [
          await replay(javascriptRunner, fixture),
          await replay(javascriptRunner, fixture),
        ],
        fixture,
      );
    },
  );

  it.skipIf(!existsSync(`${directory}/wasmtime`)).each(corpus.cases)(
    'computes the evaluate:code values for $id in Wasmtime',
    async (fixture) => {
      const runner = createWasmtimeRunner({
        directory,
        enforceProcessLimits: process.platform === 'linux',
      });
      expectCorpusValues(
        [await replay(runner, fixture), await replay(runner, fixture)],
        fixture,
      );
    },
  );

  it('denies a request that has no example reply, like the evaluator', async () => {
    const [fixture] = corpus.cases;
    const { result } = await runExampleCode(
      {
        runner: javascriptRunner,
        now: fixture!.now,
        signal: new AbortController().signal,
      },
      version,
      { ...step, grants: [] },
      fixture!.input,
      {},
    ).catch((error: unknown) => ({ result: { error } }));
    expect(result).toEqual({
      error: expect.objectContaining({ outcome: 'capability_denied' }),
    });
  });
});
