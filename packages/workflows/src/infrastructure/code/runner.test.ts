import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { CodeRequestStopped } from '../../domain/code-step.js';
import { createWasmtimeRunner } from './runner.js';
import { defineCodeStep } from './schema.js';

// Exposes each spawned Wasmtime process so cancellation tests can wait on its lifecycle events.
const spawned = vi.hoisted(() => [] as ChildProcess[]);
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();

  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      spawned.push(child);

      return child;
    },
  };
});

const directory =
  process.env.LUMA_CODE_RUNTIME_DIR ??
  fileURLToPath(new URL('../../../../../.luma/code-runtime/', import.meta.url));
const runner = createWasmtimeRunner({
  directory,
  enforceProcessLimits: process.platform === 'linux',
});
const step = (source: string, grants: string[] = []) =>
  defineCodeStep({
    id: 'calculate',
    source,
    grants,
    fields: { value: 'number' },
    limits: {
      fuel: 100000000,
      memoryBytes: 67108864,
      wallTimeMs: 5000,
      maxRequests: 4,
    },
  });
const controls = {
  now: '2026-01-01T00:00:00.000Z',
  request: async () => ({ quantity: 4 }),
};

describe.skipIf(!existsSync(`${directory}/wasmtime`))(
  'real Wasmtime code execution',
  () => {
    it('executes TypeScript and produces the same values and input digest on replay', async () => {
      const source = step(
        'function main(input: { quantity: number }) { return { value: input.quantity * 2 }; }',
      );
      const a = await runner.run(source, { quantity: 3 }, controls);
      const b = await runner.run(source, { quantity: 3 }, controls);
      expect(a.values).toEqual({ value: 6 });
      expect(a.telemetry.outcome).toBe('completed');
      expect(a.telemetry.inputDigest).toBe(b.telemetry.inputDigest);
      expect(a.values).toEqual(b.values);
    });
    it('canonicalizes input and reply ordering to match the input digest', async () => {
      const source = step(
        'function main(input, luma) { return { value: Object.keys(input)[0] === "alpha" && Object.keys(luma.request("stock"))[0] === "alpha" ? 1 : 0 }; }',
        ['stock'],
      );
      const a = await runner.run(
        source,
        { alpha: 1, beta: 2 },
        { ...controls, request: async () => ({ alpha: 1, beta: 2 }) },
      );
      const b = await runner.run(
        source,
        { beta: 2, alpha: 1 },
        { ...controls, request: async () => ({ beta: 2, alpha: 1 }) },
      );
      expect(a.values).toEqual({ value: 1 });
      expect(b.values).toEqual(a.values);
      expect(b.telemetry.inputDigest).toBe(a.telemetry.inputDigest);
    });
    it('waits for an in-flight host request after cancellation', async () => {
      const controller = new AbortController();
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let settled = false;
      const task = runner
        .run(
          step(
            'function main(input, luma) { return { value: luma.request("stock").quantity }; }',
            ['stock'],
          ),
          {},
          {
            ...controls,
            signal: controller.signal,
            request: async () => {
              entered();
              await pending;

              return { quantity: 4 };
            },
          },
        )
        .then((result) => {
          settled = true;

          return result;
        });
      await started;
      const child = spawned.at(-1)!;
      const closed = once(child, 'close');
      controller.abort();
      await closed;
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      release();
      expect((await task).telemetry.outcome).toBe('cancelled');
    });
    it('propagates sanitized host failures and keeps expected denials terminal', async () => {
      const source = step(
        'function main(input, luma) { return { value: luma.request("stock").quantity }; }',
        ['stock'],
      );
      await expect(
        runner.run(
          source,
          {},
          {
            ...controls,
            request: async () => {
              throw new Error('private-token');
            },
          },
        ),
      ).rejects.toThrow(/^Code capability request failed; retry the activity$/);
      const denied = await runner.run(
        source,
        {},
        {
          ...controls,
          request: async () => {
            throw new CodeRequestStopped('capability_denied');
          },
        },
      );
      expect(denied.telemetry.outcome).toBe('capability_denied');
      expect((await runner.run(source, {}, controls)).values).toEqual({
        value: 4,
      });
    });
    it('grants only named RPC calls and denies unknown calls before dispatch', async () => {
      const request = vi.fn(controls.request);
      const allowed = await runner.run(
        step(
          'function main(input, luma) { return { value: luma.request("stock").quantity }; }',
          ['stock'],
        ),
        {},
        { ...controls, request },
      );
      expect(allowed.values).toEqual({ value: 4 });
      expect(request).toHaveBeenCalledTimes(1);
      const denied = await runner.run(
        step(
          'function main(input, luma) { return { value: luma.request("secret").quantity }; }',
        ),
        {},
        { ...controls, request },
      );
      expect(denied.telemetry.outcome).toBe('capability_denied');
      expect(request).toHaveBeenCalledTimes(1);
    });
    it('does not expose Node, network, filesystem, real clocks or guest transport', async () => {
      const result = await runner.run(
        step(
          'function main() { return { value: [typeof process, typeof require, typeof fetch, typeof Javy, typeof Date, typeof read].every(x => x === "undefined") ? 1 : 0 }; }',
        ),
        {},
        controls,
      );
      expect(result.values).toEqual({ value: 1 });
    });
    it('terminates infinite loops, allocation attacks and endless capability requests', async () => {
      const loop = step('function main() { while(true) {} }');
      expect((await runner.run(loop, {}, controls)).telemetry.outcome).toBe(
        'resource_limit',
      );
      const memory = step(
        'function main() { const a=[]; while(true) a.push(new Uint8Array(1024*1024)); }',
      );
      expect(['resource_limit', 'code_error']).toContain(
        (await runner.run(memory, {}, controls)).telemetry.outcome,
      );
      const requests = step(
        'function main(input, luma) { while(true) luma.request("stock"); }',
        ['stock'],
      );
      expect((await runner.run(requests, {}, controls)).telemetry.outcome).toBe(
        'capability_denied',
      );
    }, 15000);
    it('kills running code when cancelled', async () => {
      const controller = new AbortController();
      const source = step('function main() { while(true) {} }');
      source.limits.fuel = 1000000000;
      const pinned = defineCodeStep(source);
      const count = spawned.length;
      const task = runner.run(
        pinned,
        {},
        { ...controls, signal: controller.signal },
      );
      // Abort only after the Wasmtime process exists, so the kill path is exercised.
      await vi.waitFor(() => expect(spawned[count]?.pid).toBeDefined(), {
        interval: 1,
      });
      controller.abort();
      expect((await task).telemetry.outcome).toBe('cancelled');
    });
    it('filters user error text and rejects undeclared output fields', async () => {
      const error = await runner.run(
        step('function main(input) { throw new Error(input.secret); }'),
        { secret: 'private-token' },
        controls,
      );
      expect(error.telemetry.outcome).toBe('code_error');
      expect(JSON.stringify(error)).not.toContain('private-token');
      expect(
        (
          await runner.run(
            step('function main() { return { extra: 1 }; }'),
            {},
            controls,
          )
        ).telemetry.outcome,
      ).toBe('invalid_output');
    });
  },
);
