import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

/** Starts an isolated supplier/mail reconciliation process with secrets carried only over IPC. */
export async function purchasingWorker(t, configuration) {
  const child = fork(
    new URL('./purchasing-reconciliation-worker.mjs', import.meta.url),
    [],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [],
      env: { ...process.env, NODE_ENV: 'test' },
    },
  );
  let stopped = false;
  const request = (message) =>
    new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            'Purchasing worker did not finish its bounded reconciliation pass',
          ),
        );
      }, 30_000);
      const receive = (result) => {
        if (result.id !== id) return;
        cleanup();
        if (result.ready) resolve();
        else
          reject(
            new Error('Purchasing worker could not complete reconciliation'),
          );
      };
      const exited = () => {
        cleanup();
        reject(
          new Error('Purchasing worker exited before finishing reconciliation'),
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', receive);
        child.off('exit', exited);
      };
      child.on('message', receive);
      child.once('exit', exited);
      child.send({ ...message, id });
    });
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.kill('SIGTERM');
    await exited;
    clearTimeout(timer);
  };
  t.onTestFinished(stop);
  await request({ type: 'start', ...configuration });
  assert.ok(child.pid);

  return { pid: child.pid, pass: () => request({ type: 'pass' }), stop };
}
