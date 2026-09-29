import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Runs a command without a shell and forwards termination signals; resolves trimmed captured
 * output or rejects with the child exit code. Pass logFd to stream both outputs to
 * a caller-owned file descriptor instead of the terminal; it overrides capture.
 * @param {string} command
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, capture?: boolean, cwd?: string, logFd?: number }} options
 * @returns {Promise<string>}
 */
export function run(
  command,
  args,
  { env = process.env, capture = false, cwd = root, logFd } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio:
        logFd !== undefined
          ? ['ignore', logFd, logFd]
          : capture
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
     * @param {NodeJS.Signals} signal
     */
    const stop = (signal) => {
      stopped = signal;
      kill(signal);
      timer ??= setTimeout(() => kill('SIGKILL'), 10_000);
    };
    const interrupt = () => stop('SIGINT');
    const terminate = () => stop('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk;
    });
    const clean = () => {
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    };
    child.once('error', (error) => {
      clean();
      reject(error);
    });
    child.once('close', (code, signal) => {
      clean();
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
                  : stopped || signal
                    ? 143
                    : code || 1,
            },
          ),
        );
    });
  });
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
