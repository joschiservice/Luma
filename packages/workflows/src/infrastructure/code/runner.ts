import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';

import { z } from 'zod';

import {
  CodeRequestStopped,
  type CodeRunner,
  codeRuntime,
  codeSlotWaitMs,
  type CodeTelemetry,
} from '../../domain/code-step.js';
import { canonicalPlaybook, playbookHash } from '../playbooks/schema.js';
import { compileCodeSource } from './compiler.js';
import { checkCodeStep } from './schema.js';
import { createSlotQueue } from './slots.js';

// Shared by every runner in the process: at most four Wasmtime children run at once, and one
// tenant holds at most three of them.
const processSlots = createSlotQueue({
  slots: 4,
  perTenant: 3,
  waitMs: codeSlotWaitMs,
});

const guestHash =
  process.platform === 'linux'
    ? process.arch === 'x64'
      ? '904b98e156dafb36f16d051bbd75a6d529cbbbaa7e715350c1bf3fe7b06f6121'
      : '23d57b6a7b3f71997b388d288b840eae3e03c6b797efd0292018ecc6216b2d15'
    : 'a9ebcec73c5d2be040389b2748deb53fd699d2b6367a8fe60127e1874a564ca1';
const scalar = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const frame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('request'), grant: z.string().max(80) }).strict(),
  z
    .object({
      type: z.literal('result'),
      value: z.record(z.string().max(80), scalar),
    })
    .strict(),
  z
    .object({ type: z.literal('error'), code: z.literal('code_error') })
    .strict(),
]);

/** Supervises a pinned Wasmtime process; only bounded JSON frames cross its stdio boundary. */
export function createWasmtimeRunner(options: {
  directory: string;
  /** Linux prlimit enforces total process CPU/address space in production. */
  enforceProcessLimits?: boolean;
}): CodeRunner {
  const directory = resolve(options.directory);
  const binary = resolve(directory, 'wasmtime');
  const guest = resolve(directory, 'guest.wasm');
  // Setup compiles the pinned guest once. Compiling it on every run would spend seconds of the wall-time budget.
  const precompiled = resolve(directory, 'guest.cwasm');

  return {
    async run(inputStep, input, controls) {
      const step = checkCodeStep(inputStep);
      const started = performance.now();
      const telemetry: CodeTelemetry = {
        runtime: codeRuntime,
        artifactDigest: step.artifactDigest,
        inputDigest: playbookHash({ input, now: controls.now }),
        wallTimeMs: 0,
        requests: 0,
        outcome: 'unavailable',
      };
      const finish = (outcome: CodeTelemetry['outcome'], values = {}) => ({
        values,
        telemetry: {
          ...telemetry,
          outcome,
          wallTimeMs: Math.round(performance.now() - started),
        },
      });
      if (controls.signal?.aborted) return finish('cancelled');
      let code: string;
      try {
        code = compileCodeSource(step.source);
      } catch {
        return finish('code_error');
      }
      const payload =
        canonicalPlaybook({ code, input, now: controls.now }) + '\n';
      if (Buffer.byteLength(payload) > 262144) return finish('invalid_output');
      try {
        const bytes = await readFile(guest);
        if (createHash('sha256').update(bytes).digest('hex') !== guestHash)
          return finish('unavailable');
        // Installation pins executable bytes; this check rejects an accidentally replaced runtime.
        const manifest = JSON.parse(
          await readFile(resolve(directory, 'manifest.json'), 'utf8'),
        ) as { wasmtime: string; precompiled?: string };
        for (const [file, digest] of [
          [binary, manifest.wasmtime],
          [precompiled, manifest.precompiled],
        ] as const)
          if (
            !digest ||
            createHash('sha256')
              .update(await readFile(file))
              .digest('hex') !== digest
          )
            return finish('unavailable');
      } catch {
        return finish('unavailable');
      }
      const enforce =
        options.enforceProcessLimits ?? process.env.NODE_ENV === 'production';
      if (enforce && process.platform !== 'linux') return finish('unavailable');
      // Code generation flags must match `wasmtime compile` in tooling/code-runtime/setup.mjs;
      // Wasmtime refuses to load an artifact compiled with different settings.
      const args = [
        'run',
        '--allow-precompiled',
        '-C',
        'parallel-compilation=n,cache=n',
        '-W',
        `fuel=${step.limits.fuel},max-memory-size=${step.limits.memoryBytes},max-memories=1,max-tables=1,max-instances=1,max-table-elements=10000,max-wasm-stack=1048576,timeout=${step.limits.wallTimeMs}ms,nan-canonicalization=y,threads=n,shared-memory=n,memory64=n,component-model=n`,
        '-O',
        'memory-reservation=0,memory-reservation-for-growth=0,memory-guard-size=0,guard-before-linear-memory=n',
        '-S',
        'inherit-network=n,inherit-env=n,tcp=n,udp=n,allow-ip-name-lookup=n,http=n,listenfd=n',
        precompiled,
      ];
      const executable = enforce ? '/usr/bin/prlimit' : binary;
      const commandArgs = enforce
        ? [
            `--as=${1024 * 1024 * 1024}`,
            `--cpu=${Math.ceil(step.limits.wallTimeMs / 1000) + 1}`,
            '--',
            binary,
            ...args,
          ]
        : args;

      // The wall-time budget starts once a slot is free; a run that waits too long retries.
      const admission = await processSlots.acquire(
        controls.tenantId,
        controls.signal,
      );
      if (admission === 'cancelled') return finish('cancelled');
      if (admission === 'busy') throw new Error('Code runner is busy');

      return new Promise((resolveResult, rejectResult) => {
        const child = spawn(executable, commandArgs, {
          cwd: directory,
          env: {
            TOKIO_WORKER_THREADS: '1',
            RAYON_NUM_THREADS: '1',
            MALLOC_ARENA_MAX: '2',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stopped = false;
        let bytes = 0;
        let buffered = '';
        const decoder = new StringDecoder('utf8');
        let processing = false;
        let pending: Promise<void> = Promise.resolve();
        let hostFailed = false;
        let result: ReturnType<typeof finish> | undefined;
        const stop = (outcome: CodeTelemetry['outcome'], values = {}) => {
          if (stopped) return;
          stopped = true;
          result = finish(outcome, values);
          child.kill('SIGKILL');
        };
        const sampling =
          process.platform === 'linux'
            ? setInterval(() => {
                if (stopped || !child.pid) return;
                void readFile(`/proc/${child.pid}/status`, 'utf8')
                  .then((status) => {
                    const peak = /VmHWM:\s+(\d+) kB/.exec(status);
                    if (peak)
                      telemetry.peakProcessMemoryBytes = Math.max(
                        telemetry.peakProcessMemoryBytes ?? 0,
                        Number(peak[1]) * 1024,
                      );
                  })
                  .catch(() => undefined);
              }, 20)
            : undefined;
        const cancel = () => stop('cancelled');
        const timer = setTimeout(
          () => stop('resource_limit'),
          step.limits.wallTimeMs,
        );
        controls.signal?.addEventListener('abort', cancel, { once: true });
        child.stdin.on('error', () => undefined);
        child.stderr.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 262144) stop('resource_limit');
          // Raw stderr can contain source and input data and is intentionally discarded.
        });
        child.stdout.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 262144) {
            stop('resource_limit');

            return;
          }
          buffered += decoder.write(chunk);
          const newline = buffered.indexOf('\n');
          if (newline < 0 || stopped) return;
          if (processing || buffered.indexOf('\n', newline + 1) >= 0) {
            stop('invalid_output');

            return;
          }
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          let message: z.infer<typeof frame>;
          try {
            message = frame.parse(JSON.parse(line));
          } catch {
            stop('invalid_output');

            return;
          }
          if (message.type === 'error') {
            stop('code_error');

            return;
          }
          if (message.type === 'result') {
            if (
              Object.keys(message.value).length !==
                Object.keys(step.fields).length ||
              Object.entries(step.fields).some(
                ([key, type]) =>
                  !Object.hasOwn(message.value, key) ||
                  (message.value[key] === null
                    ? 'null'
                    : typeof message.value[key]) !== type,
              )
            ) {
              stop('invalid_output');

              return;
            }
            stop('completed', message.value);

            return;
          }
          telemetry.requests++;
          if (
            !step.grants.includes(message.grant) ||
            telemetry.requests > step.limits.maxRequests
          ) {
            stop('capability_denied');

            return;
          }
          processing = true;
          pending = Promise.resolve()
            .then(() => controls.request(message.grant))
            .then((value) => {
              if (stopped) return;
              const response =
                canonicalPlaybook({ type: 'response', value }) + '\n';
              if (Buffer.byteLength(response) > 262144) {
                stop('resource_limit');

                return;
              }
              processing = false;
              child.stdin.write(response);
            })
            .catch((error: unknown) => {
              if (error instanceof CodeRequestStopped) stop(error.outcome);
              else {
                hostFailed = true;
                stop('capability_denied');
              }
            });
        });
        child.once('error', () => {
          result = finish('unavailable');
        });
        child.once('close', () => {
          processSlots.release(controls.tenantId);
          stopped = true;
          clearTimeout(timer);
          if (sampling) clearInterval(sampling);
          controls.signal?.removeEventListener('abort', cancel);
          // The sandbox deadline ends guest execution, not an admitted host action.
          // Keep the activity open until its request has settled and journaled.
          void pending.then(() => {
            if (hostFailed)
              rejectResult(
                new Error('Code capability request failed; retry the activity'),
              );
            else resolveResult(result ?? finish('resource_limit'));
          });
        });
        child.stdin.write(payload);
        if (controls.signal?.aborted) cancel();
      });
    },
  };
}
