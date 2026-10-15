import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { compileProject, writeOutput } from '@inlang/paraglide-js';
import icu from '@inlang/plugin-icu1';
import { loadProjectInMemory, newProject } from '@inlang/sdk';
import ts from 'typescript';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { compileCatalogOutput } from './compile-output.mjs';
import {
  compilerOptions,
  productionCompilerOptions,
} from './compiler-options.mjs';

let project;

beforeAll(async () => {
  project = await loadProjectInMemory({
    blob: await newProject({
      settings: { baseLocale: 'en', locales: ['en', 'de'], modules: [] },
    }),
    providePlugins: [icu],
  });
  await project.importFiles({
    pluginKey: icu.key,
    files: [
      {
        locale: 'en',
        content: new TextEncoder().encode(
          JSON.stringify({
            test_greeting: 'Hello {name}',
            test_count: '{count, plural, one {One order} other {Many orders}}',
            test_empty: 'No orders',
          }),
        ),
      },
      {
        locale: 'de',
        content: new TextEncoder().encode(
          JSON.stringify({
            test_greeting: 'Hallo {name}',
            test_count:
              '{count, plural, one {Eine Bestellung} other {Viele Bestellungen}}',
            test_empty: 'Keine Bestellungen',
          }),
        ),
      },
    ],
  });
});

afterAll(async () => {
  await project?.close();
});

it('keeps locale JavaScript and emits typed per-message declarations', async () => {
  const output = await compileCatalogOutput(project, compilerOptions);
  const javascript = await compileProject({
    project,
    projectPath: compilerOptions.project,
    compilerOptions: { ...compilerOptions, emitTsDeclarations: false },
  });
  expect(
    Object.fromEntries(
      Object.entries(output).filter(([file]) => !file.endsWith('.d.ts')),
    ),
  ).toEqual(javascript);
  expect(output['messages/test_greeting.d.ts']).toBeDefined();
  expect(output['messages/test_greeting.js']).toBeUndefined();
  expect(output['messages/en.js']).toBeDefined();
  expect(output['messages/de.js']).toBeDefined();

  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'luma-i18n-types-'),
  );
  try {
    await writeOutput({ directory, output, fs });
    await fs.writeFile(
      path.join(directory, 'package.json'),
      '{"type":"module"}',
    );
    const { m } = await import(
      pathToFileURL(path.join(directory, 'messages.js'))
    );
    expect(m.test_greeting({ name: 'Ada' }, { locale: 'de' })).toBe(
      'Hallo Ada',
    );
    expect(m.test_count({ count: 1 }, { locale: 'en' })).toBe('One order');
    expect(m.test_count({ count: 2 }, { locale: 'de' })).toBe(
      'Viele Bestellungen',
    );
    expect(m.test_empty({}, { locale: 'en' })).toBe('No orders');

    const consumer = path.join(directory, 'consumer.ts');
    await fs.writeFile(
      consumer,
      `import { m, test_greeting } from './messages.js';
import type { LocalizedString, MessageMetadata } from './runtime.js';

const translated: LocalizedString = test_greeting({ name: 'Ada' }, { locale: 'de' });
const metadata: MessageMetadata<{ name: NonNullable<unknown> }, { locale?: 'en' | 'de' }, {}> = test_greeting;
m.test_empty();
m.test_count({ count: 2 });
// @ts-expect-error A required placeholder is missing.
m.test_greeting({});
// @ts-expect-error Inputs are required for a message with placeholders.
m.test_greeting();
// @ts-expect-error Only configured locales are accepted.
m.test_greeting({ name: 'Ada' }, { locale: 'fr' });
// @ts-expect-error Unknown message keys are rejected.
m.test_unknown();
// @ts-expect-error Message metadata retains the required placeholders.
const inputs: NonNullable<typeof test_greeting.__paraglide>['inputs'] = {};
`,
    );
    const program = ts.createProgram([consumer], {
      noEmit: true,
      strict: true,
      types: [],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ESNext,
    });
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((error) =>
          ts.flattenDiagnosticMessageText(error.messageText, '\n'),
        ),
    ).toEqual([]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it('keeps production output unchanged and omits declarations', async () => {
  const output = await compileCatalogOutput(project, productionCompilerOptions);
  expect(output).toEqual(
    await compileProject({
      project,
      projectPath: productionCompilerOptions.project,
      compilerOptions: productionCompilerOptions,
    }),
  );
  expect(Object.keys(output).some((file) => file.endsWith('.d.ts'))).toBe(
    false,
  );
  expect(output['messages/test_greeting.js']).toBeDefined();
});
