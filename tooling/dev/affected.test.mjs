import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { matchesGlob } from 'node:path';
import { test } from 'node:test';

import {
  journeyFiles,
  journeyManifest,
  relativeImports,
  selectJourneys,
} from './affected.mjs';
import { root } from './process.mjs';

const manifest = {
  journeys: {
    'orders.e2e.mjs': {
      imports: new Set(['apps/api/e2e/orders.e2e.mjs', 'apps/api/e2e/a.mjs']),
      areas: ['packages/orders/**'],
    },
    'orders.browser.mjs': {
      imports: new Set(['apps/api/e2e/orders.browser.mjs']),
      areas: ['packages/orders/**', 'apps/web/src/features/orders/**'],
    },
    'staff.browser.mjs': {
      imports: new Set(['apps/api/e2e/staff.browser.mjs']),
      areas: ['apps/staff/**'],
    },
  },
  shared: ['packages/platform/**'],
  ignored: ['**/*.md', '**/*.test.ts'],
};
const all = Object.keys(manifest.journeys);

test('selects journeys that declare or import a changed path', () => {
  assert.deepEqual(
    selectJourneys(['apps/web/src/features/orders/list.tsx'], manifest),
    { journeys: ['orders.browser.mjs'] },
  );
  assert.deepEqual(
    selectJourneys(
      ['apps/api/e2e/a.mjs', 'apps/staff/src/main.tsx', 'docs/x.md'],
      manifest,
    ),
    { journeys: ['orders.e2e.mjs', 'staff.browser.mjs'] },
  );
  assert.deepEqual(selectJourneys(['packages/orders/README.md'], manifest), {
    journeys: [],
  });
});

test('runs every journey for shared or unmapped paths', () => {
  assert.deepEqual(
    selectJourneys(['packages/platform/src/index.ts'], manifest),
    {
      journeys: all,
      reason: 'packages/platform/src/index.ts is shared by every journey',
    },
  );
  assert.deepEqual(selectJourneys(['packages/new/src/index.ts'], manifest), {
    journeys: all,
    reason: 'packages/new/src/index.ts is not mapped to a journey',
  });
});

test('adds boot journeys to mapped changes without treating them as coverage', () => {
  const withBoot = {
    ...manifest,
    journeys: {
      ...manifest.journeys,
      'boot.e2e.mjs': { imports: new Set(), areas: ['**'] },
    },
  };
  assert.deepEqual(selectJourneys(['apps/staff/src/main.tsx'], withBoot), {
    journeys: ['staff.browser.mjs', 'boot.e2e.mjs'],
  });
  assert.equal(
    selectJourneys(['packages/new/src/index.ts'], withBoot).journeys.length,
    4,
  );
  assert.deepEqual(selectJourneys(['docs/x.md'], withBoot), { journeys: [] });
});

test('follows relative imports into tooling modules', () => {
  const imports = relativeImports('apps/api/e2e/orders.browser.mjs');
  assert.ok(imports.has('apps/api/e2e/helpers.mjs'));
  assert.ok(imports.has('tooling/performance/report.mjs'));
});

test('every journey is mapped and every declared path exists', () => {
  const { journeys, shared, ignored } = journeyManifest();
  assert.deepEqual(Object.keys(journeys), journeyFiles());
  const tracked = execFileSync('git', ['ls-files'], {
    cwd: root,
    encoding: 'utf8',
  }).split('\n');
  const patterns = new Set([
    ...shared,
    ...ignored,
    ...Object.values(journeys).flatMap(({ areas }) => areas),
  ]);
  for (const pattern of patterns)
    assert.ok(
      tracked.some((file) => matchesGlob(file, pattern)),
      `apps/api/e2e/journey-areas.mjs: ${pattern} matches no tracked file`,
    );
});
