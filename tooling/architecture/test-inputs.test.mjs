import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, matchesGlob, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

const unhashed = [
  // Generated local state; workflow tests record its presence in LUMA_TEST_CAPABILITIES and
  // hash the setup recipe instead.
  '.luma/**',
  // The simulator serves the built control panel; its tests do not load it.
  'apps/simulator-web/dist/**',
];
// Journeys run outside the cached Turbo test task; tooling/dev/affected.mjs selects them.
const uncached = ['apps/api/e2e/**'];

/** Lists tracked workspace packages with their directories, keyed by package name. */
function workspacePackages() {
  const workspaces = new Map();
  for (const file of git('ls-files', '*package.json')) {
    if (file === 'package.json' || file.includes('node_modules/')) continue;
    const manifest = JSON.parse(readFileSync(join(root, file), 'utf8'));
    workspaces.set(manifest.name, { directory: dirname(file), manifest });
  }

  return workspaces;
}

/** Runs git in the repository root and returns non-empty output lines. */
function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/** Returns the directories of a package's transitive workspace dependencies. */
function dependencyDirectories(name, workspaces, seen = new Set()) {
  const { manifest } = workspaces.get(name);
  for (const dependency of Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })) {
    if (!workspaces.has(dependency) || seen.has(dependency)) continue;
    seen.add(dependency);
    dependencyDirectories(dependency, workspaces, seen);
  }

  return [...seen].map((dependency) => workspaces.get(dependency).directory);
}

/** Accepts a file under the pattern, or a directory the pattern reads files from. */
function covers(pattern, { target, directory }) {
  return (
    matchesGlob(target, pattern) ||
    (directory && pattern.startsWith(`${target}/`))
  );
}

/** Reads the root-relative extra inputs a package declares for its test task. */
function testInputs(directory) {
  const file = join(root, directory, 'turbo.json');
  if (!existsSync(file)) return [];
  const inputs =
    JSON.parse(readFileSync(file, 'utf8')).tasks?.test?.inputs ?? [];

  return inputs
    .filter((input) => input.startsWith('$TURBO_ROOT$/'))
    .map((input) => input.slice('$TURBO_ROOT$/'.length));
}

/**
 * Finds relative path literals that leave the file's package. Template expressions and glob
 * syntax are replaced by a sample segment so the literal can be matched like a file path.
 */
function escapingPaths(file, directory) {
  const source = readFileSync(join(root, file), 'utf8');
  const paths = [];
  for (const [, literal] of source.matchAll(
    /['"`]((?:\.\.\/)+[^'"`\n]*)['"`]/g,
  )) {
    const sample = literal.replaceAll(
      /\$\{[^}]*\}|[@!?+]\([^)]*\)|\{[^}]*\}|\*+/g,
      'sample',
    );
    const target = relative(root, resolve(root, dirname(file), sample));
    if (
      target.startsWith('..') ||
      !relative(directory, target).startsWith('..')
    )
      continue;
    paths.push({ literal, target, directory: sample.endsWith('/') });
  }

  return paths;
}

test('cached package tests declare every file they read from outside the package', () => {
  const workspaces = workspacePackages();
  const missing = [];
  for (const [name, { directory, manifest }] of workspaces) {
    if (!manifest.scripts?.test) continue;
    const covered = [
      ...dependencyDirectories(name, workspaces).map((dir) => `${dir}/**`),
      ...testInputs(directory),
      ...unhashed,
    ];
    for (const file of git('ls-files', directory)) {
      if (!/\.(?:[cm]?[jt]sx?)$/.test(file)) continue;
      if (uncached.some((pattern) => matchesGlob(file, pattern))) continue;
      for (const path of escapingPaths(file, directory))
        if (!covered.some((pattern) => covers(pattern, path)))
          missing.push(`${file}: ${path.literal} -> ${path.target}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    'Add these paths to the package turbo.json test inputs or declare the workspace dependency',
  );
});

test('declared test inputs match tracked files', () => {
  const tracked = git('ls-files');
  for (const { directory } of workspacePackages().values())
    for (const pattern of testInputs(directory))
      assert.ok(
        tracked.some((file) => matchesGlob(file, pattern)),
        `${directory}/turbo.json: ${pattern} matches no tracked file`,
      );
});

test('the workspace root does not depend on workspace packages', () => {
  // Turbo hashes the sources of root dependencies into every task, so one would invalidate
  // every cached result and make --affected select every task.
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const workspaces = workspacePackages();
  assert.deepEqual(
    Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    }).filter((name) => workspaces.has(name)),
    [],
    'Declare workspace packages used by tooling scripts in tooling/package.json',
  );
});

test('declared test inputs match no ignored files', () => {
  // Explicit input globs also hash ignored files, such as caches written by test runs.
  // Ignored directories are listed once; a sample path stands for their contents.
  const ignored = git(
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
  ).map((path) => (path.endsWith('/') ? `${path}sample` : path));
  for (const { directory } of workspacePackages().values())
    for (const pattern of testInputs(directory)) {
      const matched = ignored.filter((file) => matchesGlob(file, pattern));
      assert.deepEqual(matched, [], `${directory}/turbo.json: ${pattern}`);
    }
});
