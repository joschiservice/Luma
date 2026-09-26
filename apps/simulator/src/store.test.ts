import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { journal } from '@luma/simulator-core';
import { expect, test } from 'vitest';

import { createRun, mutate } from './run.js';
import { openStore } from './store.js';

test('timed transactions preserve results and roll back failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-store-'));
  const operations: string[] = [];
  const store = await openStore(
    join(directory, 'runs.sqlite'),
    (name, work) => {
      operations.push(name);

      return work();
    },
  );
  try {
    expect(
      await store.transact((runs) => {
        runs.test = createRun('test');

        return 'result';
      }),
    ).toBe('result');
    await expect(
      store.transact(() => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect(await store.transact((runs) => Object.keys(runs))).toEqual(['test']);
    expect(operations).toEqual(
      expect.arrayContaining([
        'simulator.transaction',
        'sqlite.BEGIN',
        'sqlite.SELECT',
        'simulator.decode',
        'simulator.encode',
        'sqlite.COMMIT',
        'sqlite.ROLLBACK',
      ]),
    );
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('migrates legacy history once and pages it without loading or rewriting run state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-store-upgrade-'));
  const path = join(directory, 'runs.sqlite');
  const legacy = createRun('legacy');
  for (let i = 0; i < 250; i++) journal(legacy.clock, 'request', { index: i });
  const expected = structuredClone(legacy.clock.journal).reverse();
  const database = new DatabaseSync(path);
  database.exec(
    'CREATE TABLE simulator_state (id INTEGER PRIMARY KEY, document TEXT NOT NULL)',
  );
  database
    .prepare('INSERT INTO simulator_state VALUES (1, ?)')
    .run(JSON.stringify({ legacy }));
  database.close();
  const operations: string[] = [];
  let store = await openStore(path, (name, work) => {
    operations.push(name);

    return work();
  });
  try {
    operations.length = 0;
    expect(store.exists('legacy')).toBe(true);
    expect(store.exists('missing')).toBe(false);
    expect(store.list()[0]).not.toHaveProperty('jtl');
    expect(store.list()[0]).not.toHaveProperty('clock.journal');
    expect(store.get('legacy')?.clock.journal).toEqual([]);
    const entries = [];
    let before: number | undefined;
    do {
      const page = store.journal('legacy', 100, before);
      entries.push(...page.items);
      before = page.nextCursor ?? undefined;
    } while (before !== undefined);
    expect(entries).toEqual(expected);
    expect(operations).toEqual([]);
    const inspect = new DatabaseSync(path, { readOnly: true });
    expect(
      inspect
        .prepare('SELECT length(document) AS size FROM simulator_runs')
        .get()!.size,
    ).toBeLessThan(10000);
    expect(
      inspect
        .prepare("SELECT name FROM sqlite_master WHERE name='simulator_state'")
        .get(),
    ).toBeUndefined();
    inspect.close();
    await store.close();
    store = await openStore(path);
    expect(store.journal('legacy').items).toEqual(expected.slice(0, 100));
    expect(store.get('legacy')?.jtl).toEqual(legacy.jtl);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('commits new history with state, rolls both back on failure, and clears history on reset', async () => {
  const store = await openStore(':memory:');
  try {
    await store.transact((runs) => {
      runs.a = createRun('a');
      runs.b = createRun('b');
    });
    const initial = store.journal('a');
    await expect(
      store.transact(
        (runs) => {
          runs.a!.clock.speed = 20;
          journal(runs.a!.clock, 'failed', {});

          // A failure after persistence must roll back both tables.
          return () => undefined;
        },
        { runIds: ['a'] },
      ),
    ).rejects.toThrow();
    expect(store.get('a')?.clock.speed).toBe(1);
    expect(store.journal('a')).toEqual(initial);
    await store.transact(
      (runs) => {
        expect(Object.keys(runs)).toEqual(['a']);
        expect(runs.a!.clock.journal).toEqual([]);
        runs.a!.clock.speed = 5;
        journal(runs.a!.clock, 'saved', {});
      },
      { runIds: ['a'] },
    );
    expect(store.get('a')?.clock.speed).toBe(5);
    expect(store.journal('a').items[0]?.kind).toBe('saved');
    expect(store.journal('b')).toEqual(initial);
    const saved = store.journal('a');
    await store.transact(
      (runs) => {
        const restored = structuredClone(runs.a!);
        journal(restored.clock, 'scenario-error', {
          message: 'Transition failed',
        });
        runs.a = restored;
      },
      { runIds: ['a'] },
    );
    expect(store.journal('a').items.slice(1)).toEqual(saved.items);
    await store.transact(
      (runs) => {
        runs.a = createRun('a');
      },
      { runIds: ['a'], resetJournal: true },
    );
    expect(store.journal('a')).toEqual(initial);
    expect(() => store.journal('a', 101)).toThrow('Invalid journal page');
    expect(() => store.journal('a', 0)).toThrow('Invalid journal page');
  } finally {
    await store.close();
  }
});

test('keeps the legacy document intact when migration fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-store-failed-upgrade-'));
  const path = join(directory, 'runs.sqlite');
  const run = createRun('legacy');
  run.clock.journal.push(run.clock.journal[0]!);
  const document = JSON.stringify({ legacy: run });
  const database = new DatabaseSync(path);
  database.exec(
    'CREATE TABLE simulator_state (id INTEGER PRIMARY KEY, document TEXT NOT NULL)',
  );
  database.prepare('INSERT INTO simulator_state VALUES (1, ?)').run(document);
  try {
    await expect(openStore(path)).rejects.toThrow();
    expect(
      database.prepare('SELECT document FROM simulator_state').get()!.document,
    ).toBe(document);
    expect(
      database.prepare('SELECT count(*) AS count FROM simulator_journal').get()!
        .count,
    ).toBe(0);
    expect(
      database.prepare('SELECT count(*) AS count FROM simulator_runs').get()!
        .count,
    ).toBe(0);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('read methods remain available while another connection holds the write lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-store-read-lock-'));
  const path = join(directory, 'runs.sqlite');
  const store = await openStore(path);
  await store.transact((runs) => {
    runs.test = createRun('test');
  });
  const writer = new DatabaseSync(path);
  writer.exec('BEGIN IMMEDIATE');
  try {
    expect(store.list()[0]?.id).toBe('test');
    expect(store.exists('test')).toBe(true);
    expect(store.get('test')?.id).toBe('test');
    expect(store.journal('test').items).toHaveLength(4);
  } finally {
    writer.exec('ROLLBACK');
    writer.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('restores total quantities in saved shipped orders without resetting the run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-store-quantities-'));
  const path = join(directory, 'runs.sqlite');
  let store = await openStore(path);
  try {
    await store.transact((runs) => {
      const run = createRun('saved');
      mutate(run, 'shopify', { kind: 'order', id: '99', quantity: 3 });
      mutate(run, 'shopify', { kind: 'ship', id: '99' });
      delete run.shopify.nodes['gid://shopify/FulfillmentOrderLineItem/99']!
        .totalQuantity;
      runs.saved = run;
    });
    await store.close();
    store = await openStore(path);
    expect(
      store.get('saved')?.shopify.nodes[
        'gid://shopify/FulfillmentOrderLineItem/99'
      ],
    ).toMatchObject({
      totalQuantity: 3,
      remainingQuantity: 0,
    });
    await store.close();
    store = await openStore(path);
    expect(
      store.get('saved')?.shopify.nodes[
        'gid://shopify/FulfillmentOrderLineItem/99'
      ],
    ).toMatchObject({
      totalQuantity: 3,
      remainingQuantity: 0,
    });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
