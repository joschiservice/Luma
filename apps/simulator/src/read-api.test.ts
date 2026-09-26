import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { journal } from '@luma/simulator-core';
import { expect, test } from 'vitest';

import { createApp } from './app.js';
import { createRun } from './run.js';
import { openStore } from './store.js';

test('serves bounded summaries and journal pages without state transactions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'luma-read-api-'));
  const path = join(directory, 'runs.sqlite');
  const store = await openStore(path);
  await store.transact((runs) => {
    const run = createRun('large', 44, 'manual');
    for (let index = 0; index < 1000; index++)
      journal(run.clock, 'request', { index, body: 'x'.repeat(1000) });
    runs.large = run;
  });
  await store.close();
  const measurements: string[] = [];
  const calls: string[] = [];
  const token = 'read-api-synthetic-token';
  const app = await createApp(
    path,
    token,
    false,
    (name, work) => {
      measurements.push(name);

      return work();
    },
    async (id, action) => {
      calls.push(`${id}:${action}`);

      return { connected: true };
    },
  );
  const read = (url: string, authenticated = true) =>
    app.inject({
      url,
      ...(authenticated
        ? { headers: { authorization: `Bearer ${token}` } }
        : {}),
    });
  try {
    measurements.length = 0;
    const summaries = await read('/api/runs');
    expect(summaries.statusCode).toBe(200);
    expect(summaries.body.length).toBeLessThan(1000);
    expect(summaries.json()[0]).not.toHaveProperty('jtl');
    expect(summaries.json()[0]).not.toHaveProperty('clock.journal');
    const detail = await read('/api/runs/large');
    expect(detail.json().jtl.orders).toHaveLength(2);
    expect(detail.json().clock.journal).toEqual([]);
    const first = (await read('/api/runs/large/journal')).json();
    expect(first.items).toHaveLength(100);
    expect(first.items[0].detail.index).toBe(999);
    // New writes must not shift an existing cursor's older page.
    await app.inject({
      method: 'POST',
      url: '/api/runs/large/control',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'speed', speed: 2 },
    });
    measurements.length = 0;
    const second = (
      await read(`/api/runs/large/journal?before=${first.nextCursor}&limit=100`)
    ).json();
    expect(second.items).toHaveLength(100);
    expect(second.items[0].detail.index).toBe(899);
    expect(
      new Set([...first.items, ...second.items].map((entry) => entry.sequence))
        .size,
    ).toBe(200);
    expect((await read('/api/runs/large/operations')).json()).toEqual({
      connected: true,
    });
    expect(calls).toEqual(['large:status']);
    expect(measurements).toEqual([]);
    for (const query of [
      'limit=101',
      'limit=0',
      'limit=1.5',
      'before=-1',
      'before=no',
    ])
      expect((await read(`/api/runs/large/journal?${query}`)).statusCode).toBe(
        400,
      );
    for (const suffix of ['', '/journal', '/operations']) {
      expect((await read(`/api/runs/large${suffix}`, false)).statusCode).toBe(
        401,
      );
      expect((await read(`/api/runs/missing${suffix}`)).statusCode).toBe(409);
    }
    expect(calls).toHaveLength(1);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
