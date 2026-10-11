import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Runs git in the repository root and returns non-empty output lines. */
function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

test('workspaces declare every workspace package they import', () => {
  // pnpm links only declared packages, but a package the root once declared stayed resolvable
  // from every workspace, so missing declarations went unnoticed.
  const workspaces = git('ls-files', '*package.json')
    .filter((file) => !file.includes('node_modules/'))
    .map((file) => ({
      directory: dirname(file),
      manifest: JSON.parse(readFileSync(join(root, file), 'utf8')),
    }))
    .sort((a, b) => b.directory.length - a.directory.length);
  const missing = [];
  for (const file of git('ls-files', '*.ts', '*.tsx', '*.mjs', '*.js')) {
    const owner = workspaces.find(
      ({ directory }) => directory === '.' || file.startsWith(`${directory}/`),
    );
    const declared = new Set([
      owner.manifest.name,
      ...Object.keys({
        ...owner.manifest.dependencies,
        ...owner.manifest.devDependencies,
        ...owner.manifest.peerDependencies,
      }),
    ]);
    // The scanner reads import syntax only, so import text in string fixtures is ignored.
    const { importedFiles } = ts.preProcessFile(
      readFileSync(join(root, file), 'utf8'),
      true,
      true,
    );
    for (const { fileName } of importedFiles) {
      const name = /^@luma\/[a-z0-9-]+/.exec(fileName)?.[0];
      if (name && !declared.has(name))
        missing.push(`${file}: ${name} (${owner.directory}/package.json)`);
    }
  }

  assert.deepEqual(missing, []);
});
