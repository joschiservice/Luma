import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = 'apps/web/src/';

// Lower layers never import higher ones. Features may use each other, but without cycles.
const ranks = { lib: 0, kit: 1, shared: 2, features: 3, shell: 4 };

/** Places a web module in its layer; feature modules also name their feature. */
function layerOf(file) {
  const [top, name] = file.slice(source.length).split('/');
  if (top === 'lib' || top === 'kit' || top === 'shared') return { layer: top };
  if (top === 'features') return { layer: 'features', feature: name };

  // Routes, the router, server entry and shell compose everything.
  return { layer: 'shell' };
}

/** Resolves a relative specifier to a tracked web module. */
function resolve(from, specifier, tracked) {
  const base = normalize(join(dirname(from), specifier.split('?')[0]));
  for (const suffix of ['', '.ts', '.tsx', '/index.ts', '/index.tsx'])
    if (tracked.has(base + suffix)) return base + suffix;
  if (base.endsWith('.js'))
    for (const suffix of ['.ts', '.tsx'])
      if (tracked.has(base.slice(0, -3) + suffix))
        return base.slice(0, -3) + suffix;

  return null;
}

/** Lists production web modules with the web modules each imports. */
function graph() {
  const tracked = new Set(
    execFileSync('git', ['ls-files', source], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter((file) => /\.(tsx?)$/.test(file)),
  );
  const modules = [...tracked].filter(
    (file) =>
      !/\.(test|stories|fixture)\.tsx?$/.test(file) &&
      !/(storybook-support|storybook-shell)\.tsx?$/.test(file) &&
      !file.endsWith('routeTree.gen.ts') &&
      existsSync(join(root, file)),
  );

  return modules.map((file) => ({
    file,
    imports: ts
      .preProcessFile(readFileSync(join(root, file), 'utf8'), true, true)
      .importedFiles.map(({ fileName }) => fileName)
      .filter((name) => name.startsWith('.'))
      .map((name) => resolve(file, name, tracked))
      .filter((target) => target !== null),
  }));
}

test('web modules import only their own or lower layers', () => {
  const violations = [];
  for (const { file, imports } of graph()) {
    const from = layerOf(file);
    for (const target of imports) {
      const to = layerOf(target);
      if (ranks[to.layer] > ranks[from.layer])
        violations.push(
          `${file} (${from.layer}) imports ${target} (${to.layer})`,
        );
    }
  }

  assert.deepEqual(violations, []);
});

test('features do not depend on each other in a cycle', () => {
  const edges = new Map();
  for (const { file, imports } of graph()) {
    const from = layerOf(file);
    if (!from.feature) continue;
    for (const target of imports) {
      const to = layerOf(target);
      if (!to.feature || to.feature === from.feature) continue;
      const key = `${from.feature}>${to.feature}`;
      edges.set(key, [...(edges.get(key) ?? []), `${file} imports ${target}`]);
    }
  }
  const next = new Map();
  for (const key of edges.keys()) {
    const [a, b] = key.split('>');
    next.set(a, [...(next.get(a) ?? []), b]);
  }
  // Tarjan's algorithm finds features that reach each other.
  const index = new Map();
  const low = new Map();
  const stack = [];
  const cycles = [];
  let counter = 0;
  const visit = (node) => {
    index.set(node, counter);
    low.set(node, counter++);
    stack.push(node);
    for (const target of next.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node), low.get(target)));
      } else if (stack.includes(target))
        low.set(node, Math.min(low.get(node), index.get(target)));
    }
    if (low.get(node) === index.get(node)) {
      const members = [];
      let member;
      do {
        member = stack.pop();
        members.push(member);
      } while (member !== node);
      if (members.length > 1) cycles.push(members.sort());
    }
  };
  for (const node of next.keys()) if (!index.has(node)) visit(node);

  assert.deepEqual(
    cycles.map((members) =>
      [...edges]
        .filter(([key]) => key.split('>').every((f) => members.includes(f)))
        .flatMap(([, uses]) => uses),
    ),
    [],
  );
});
