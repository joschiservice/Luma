import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ESLint } from 'eslint';

import ui from './eslint-plugin.mjs';
import { cssFindings } from './ui-policy.mjs';

test('CSS policy distinguishes tokens and layout from literal colors and primitive restyling', () => {
  assert.deepEqual(
    cssFindings(
      '.feature { color: var(--foreground); gap: 1rem; }',
      'feature.css',
    ),
    [],
  );
  const findings = cssFindings(
    `
/* #fff is not a declaration */
.feature { color: var(--foreground, #fff); background: rgb(0 0 0); }
.feature [data-slot="card"] { padding: 2px; margin: 2px; }
.ui-badge { color: red; }
`,
    'feature.css',
  );
  assert.deepEqual(
    findings.map((f) => f.rule),
    ['raw-color', 'raw-color', 'primitive-appearance', 'primitive-appearance'],
  );
});

test('JSX policy resolves aliased primitive imports and allows layout classes and semantic styles', async () => {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.jsx'],
        languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
        plugins: { ui },
        rules: { 'ui/primitive-appearance': 'error' },
      },
    ],
  });
  const lint = async (code) =>
    (await eslint.lintText(code, { filePath: 'feature.jsx' }))[0].messages;
  assert.equal(
    (
      await lint(
        'import { Card as Panel } from "@luma/ui/components/primitives/card"; const x = <Panel className="w-full mt-2 shadow-panel shadow-report" />;',
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await lint(
        'import { Card as Panel } from "@luma/ui/components/primitives/card"; const x = <Panel className="hover:bg-red-500" />;',
      )
    ).length,
    1,
  );
  assert.equal(
    (await lint('const x = <div style={{color: "var(--foreground)"}} />;'))
      .length,
    0,
  );
  assert.equal(
    (await lint('const x = <div style={{color: "#ffffff"}} />;')).length,
    1,
  );
  assert.equal(
    (
      await lint(
        'import { Card } from "@luma/ui/components/primitives/card"; const x = <Card style={{ padding: 8 }} />;',
      )
    ).length,
    1,
  );
  assert.equal(
    (await lint('const x = <div style={{color: `#ffffff`}} />;')).length,
    1,
  );
  assert.equal(
    (
      await lint(
        'import * as Cards from "@luma/ui/components/primitives/card"; const x = <Cards.Card className="p-4" />;',
      )
    ).length,
    1,
  );
});
