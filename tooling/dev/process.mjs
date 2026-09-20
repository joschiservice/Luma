import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Runs a command without a shell and forwards termination signals; resolves trimmed captured
 * output or rejects with the child exit code.
 */
export function run(
  command,
  args,
  { env = process.env, capture = false, cwd = root } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let output = '';
    let stopped;
    let timer;
    const kill = (signal) => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
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
 */
export function fail(error) {
  if (![130, 143].includes(error.exitCode)) console.error(error.message);
  process.exitCode = error.exitCode ?? 1;
}
