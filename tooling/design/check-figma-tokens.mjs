import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const [css, snapshotText] = await Promise.all([
  readFile(new URL('packages/ui/src/styles/globals.css', root), 'utf8'),
  readFile(new URL('design/figma-tokens.json', root), 'utf8'),
]);
const snapshot = JSON.parse(snapshotText);

function declarations(selector) {
  const block = css.match(new RegExp(`${selector}\\s*\\{([^}]+)\\}`))?.[1];
  if (!block) throw new Error(`Missing CSS block: ${selector}`);

  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+)\s*:\s*(#[\da-f]+)\s*;/gi)].map(
      ([, name, value]) => [name, value.toLowerCase()],
    ),
  );
}

const light = declarations(':root');
const themes = { light, dark: { ...light, ...declarations('\\.dark') } };
const differences = [];
for (const [theme, expected] of Object.entries(snapshot.colors)) {
  for (const name of new Set([
    ...Object.keys(expected),
    ...Object.keys(themes[theme]),
  ])) {
    if (themes[theme][name] !== expected[name]) {
      differences.push(
        `${theme} --${name}: CSS ${themes[theme][name] ?? '(missing)'}, Figma snapshot ${expected[name] ?? '(missing)'}`,
      );
    }
  }
}
for (const [token, expected] of Object.entries(snapshot.fonts)) {
  const actual = css.match(
    new RegExp(`--font-${token}:\\s*['"]([^'"]+)['"]`),
  )?.[1];
  if (actual !== expected) {
    differences.push(
      `--font-${token}: CSS ${actual}, Figma snapshot ${expected}`,
    );
  }
}

if (differences.length) {
  console.error(differences.join('\n'));
  console.error(
    'Reconcile Figma and CSS, then export the verified snapshot. See docs/design-workflow.md.',
  );
  process.exitCode = 1;
} else {
  console.log(
    `Figma snapshot matches ${Object.keys(light).length} colors in both themes and ${Object.keys(snapshot.fonts).length} font roles.`,
  );
}
