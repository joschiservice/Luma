import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { evaluateCodeCorpus } from './code.mjs';

const directory =
  process.env.LUMA_CODE_RUNTIME_DIR ?? resolve('.luma/code-runtime');

test(
  'code replay produces stable reports and rejects unexpected or missing requests',
  { skip: !existsSync(`${directory}/wasmtime`) },
  async () => {
    const corpus = JSON.parse(
      await readFile(
        new URL('./fixtures/code-corpus.json', import.meta.url),
        'utf8',
      ),
    );
    const first = await evaluateCodeCorpus(corpus, directory);
    assert.equal(first.passed, true);
    assert.deepEqual(await evaluateCodeCorpus(corpus, directory), first);
    corpus.cases[0].replies[0].grant = 'not-stock';
    assert.equal((await evaluateCodeCorpus(corpus, directory)).passed, false);
  },
);
