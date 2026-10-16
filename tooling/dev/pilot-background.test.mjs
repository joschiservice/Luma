import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { startPilotBackgroundWork } from '../pilot/background.mjs';

const fixture = () => ({
  observe: async () => {},
  link: async () => {},
  demo: async () => {},
  quantityChanges: async () => {},
  checkInventory: async () => {},
  detect: async () => {},
});

test(
  'sync keeps advancing during slow detection, without overlapping either pass',
  { timeout: 2000 },
  async (t) => {
    const detecting = Promise.withResolvers();
    const release = Promise.withResolvers();
    const progressed = Promise.withResolvers();
    let passes = 0,
      activeImports = 0,
      detections = 0;
    const pilot = {
      ...fixture(),
      observe: async (options) => {
        assert.deepEqual(options, { passes: 1, refresh: false, check: false });
        assert.equal(++activeImports, 1);
        await setImmediate();
        activeImports--;
        if (++passes === 4) progressed.resolve();
      },
      detect: async () => {
        detections++;
        detecting.resolve();
        await release.promise;
      },
    };
    const stop = startPilotBackgroundWork(pilot, assert.fail, {
      syncIntervalMs: 1,
      maintenanceIntervalMs: 1,
    });
    t.after(async () => {
      release.resolve();
      await stop();
    });
    await detecting.promise;
    await progressed.promise;
    assert.equal(detections, 1);
    let stopped = false;
    const closing = stop().then(() => {
      stopped = true;
    });
    await setImmediate();
    assert.equal(stopped, false);
    release.resolve();
    await closing;
    const finished = passes;
    await setImmediate();
    assert.equal(passes, finished);
    assert.equal(detections, 1);
  },
);

test(
  'failed passes retry while other background steps continue',
  { timeout: 2000 },
  async (t) => {
    const progressed = Promise.withResolvers();
    const detected = Promise.withResolvers();
    const errors = [];
    let passes = 0;
    const pilot = {
      ...fixture(),
      observe: async () => {
        if (++passes === 1) throw new Error('read unavailable');
        progressed.resolve();
      },
      link: async () => {
        throw new Error('link unavailable');
      },
      detect: async () => {
        detected.resolve();
      },
    };
    const stop = startPilotBackgroundWork(
      pilot,
      (message) => errors.push(message),
      { syncIntervalMs: 1 },
    );
    t.after(stop);
    await Promise.all([progressed.promise, detected.promise]);
    assert.deepEqual(errors, [
      'Pilot sync pass failed',
      'Pilot sync step failed',
    ]);
  },
);

test(
  'shutdown drains active steps and skips remaining maintenance work',
  { timeout: 2000 },
  async () => {
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    let detected = false;
    const pilot = {
      ...fixture(),
      checkInventory: async () => {
        entered.resolve();
        await release.promise;
      },
      detect: async () => {
        detected = true;
      },
    };
    const stop = startPilotBackgroundWork(pilot, assert.fail);
    await entered.promise;
    const closing = stop();
    release.resolve();
    await closing;
    assert.equal(detected, false);
  },
);
