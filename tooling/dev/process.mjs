import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Runs a command without a shell and forwards termination signals; resolves trimmed captured
 * output or rejects with the child exit code. A repeated interrupt, or a graceful stop that
 * takes over ten seconds, kills the child; exiting this process kills it too. Pass logFd to
 * stream both outputs to a caller-owned file descriptor instead of the terminal; it overrides
 * capture. Pass `prefix` to stream each output line to this process's output behind that label,
 * so concurrent commands stay readable. Aborting `signal` stops the child as SIGTERM would.
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, capture?: boolean, cwd?: string, logFd?: number, signal?: AbortSignal, prefix?: string }} options
 * @returns {Promise<string>}
 */
export function run(
  command,
  args,
  {
    env = process.env,
    capture = false,
    cwd = root,
    logFd,
    signal,
    prefix,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio:
        logFd !== undefined
          ? ['ignore', logFd, logFd]
          : capture || prefix !== undefined
            ? ['ignore', 'pipe', 'pipe']
            : 'inherit',
    });
    let output = '';
    /** @type {NodeJS.Signals | undefined} */
    let stopped;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    /** Signals the owned process group.
     * @param {NodeJS.Signals} signal
     */
    const kill = (signal) => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ESRCH'
        ))
          throw error;
      }
    };
    /** Forwards termination and schedules forced cleanup.
     * @param {NodeJS.Signals} received
     */
    const stop = (received) => {
      if (stopped) return;
      stopped = received;
      kill(received);
      timer = setTimeout(() => kill('SIGKILL'), 10_000);
    };
    /**
     * Forwards a signal to the child, which runs in its own process group and so only gets the
     * terminal's signals from here; a second signal kills it.
     * @param {NodeJS.Signals} received
     */
    const forward = (received) => {
      if (stopped) kill('SIGKILL');
      else stop(received === 'SIGINT' ? 'SIGINT' : 'SIGTERM');
    };
    const orphan = () => kill('SIGKILL');
    const abort = () => stop('SIGTERM');
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    process.on('SIGHUP', forward);
    process.on('exit', orphan);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    /**
     * Writes complete lines behind the prefix and keeps a trailing partial line for later.
     * @param {NodeJS.WriteStream} target
     */
    const lines = (target) => {
      let pending = '';

      return {
        /**
         * Adds output and writes every line it completes.
         * @param {Buffer | string} chunk
         */
        write(chunk) {
          const parts = (pending + chunk).split('\n');
          pending = parts.pop() ?? '';
          for (const line of parts) target.write(`${prefix} ${line}\n`);
        },
        flush() {
          if (pending) target.write(`${prefix} ${pending}\n`);
          pending = '';
        },
      };
    };
    const out = prefix === undefined ? undefined : lines(process.stdout);
    const err = prefix === undefined ? undefined : lines(process.stderr);
    child.stdout?.on('data', (chunk) => {
      if (capture) output += chunk;
      out?.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (capture) output += chunk;
      err?.write(chunk);
    });
    const clean = () => {
      clearTimeout(timer);
      process.removeListener('SIGINT', forward);
      process.removeListener('SIGTERM', forward);
      process.removeListener('SIGHUP', forward);
      process.removeListener('exit', orphan);
      signal?.removeEventListener('abort', abort);
    };
    child.once('error', (error) => {
      clean();
      reject(error);
    });
    child.once('close', (code, exitSignal) => {
      clean();
      out?.flush();
      err?.flush();
      if (code === 0 && !stopped) resolve(output.trim());
      else
        reject(
          Object.assign(
            new Error(
              `${command} failed${capture ? `: ${output.trim()}` : ''}`,
            ),
            {
              exitCode:
                stopped === 'SIGINT'
                  ? 130
                  : stopped || exitSignal
                    ? 143
                    : code || 1,
            },
          ),
        );
    });
  });
}

/**
 * Runs long-lived commands side by side. When any exits, the others are stopped; settles with
 * the first command's outcome only after all have exited, so callers can release shared
 * resources such as a simulator afterwards.
 * @param {Array<[string, string[], Parameters<typeof run>[2]?]>} commands
 * @returns {Promise<void>}
 */
export async function runTogether(commands) {
  const controller = new AbortController();
  /** @type {{ error?: unknown } | undefined} */
  let first;
  await Promise.all(
    commands.map(([command, args, options]) =>
      run(command, args, { ...options, signal: controller.signal }).then(
        () => {
          first ??= {};
          controller.abort();
        },
        (error) => {
          first ??= { error };
          controller.abort();
        },
      ),
    ),
  );
  if (first && 'error' in first) throw first.error;
}

/**
 * Reports a command failure and sets the process exit code, suppressing expected
 * interruption messages.
 * @param {unknown} error
 */
export function fail(error) {
  const exitCode =
    error instanceof Error &&
    'exitCode' in error &&
    typeof error.exitCode === 'number'
      ? error.exitCode
      : 1;
  if (![130, 143].includes(exitCode))
    console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = exitCode;
}
