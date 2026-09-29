import { mkdir, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, release, totalmem } from 'node:os';
import { join } from 'node:path';

import { fail, root, run } from '../dev/process.mjs';
import { benchmarkPlan } from './plan.mjs';

try {
  const plan = benchmarkPlan(process.argv.slice(2));
  const binary = join(root, '.luma/tools/hyperfine');
  let hyperfine;
  try {
    hyperfine = await run(binary, ['--version'], { capture: true });
  } catch {
    throw new Error('Run pnpm setup:benchmarks before benchmarking.');
  }
  const startedAt = new Date().toISOString();
  const directory = join(
    root,
    '.luma/benchmarks',
    `${startedAt.replaceAll(':', '-')}-${plan.label}`,
  );
  await mkdir(directory, { recursive: true });
  const metadata = {
    ...plan,
    startedAt,
    node: process.version,
    hyperfine,
    pnpm: await run('pnpm', ['--version'], { capture: true }),
    commit: await run('git', ['rev-parse', 'HEAD'], { capture: true }),
    dirty: Boolean(
      await run('git', ['status', '--porcelain'], { capture: true }),
    ),
    platform: process.platform,
    architecture: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model,
    availableParallelism: availableParallelism(),
    memoryBytes: totalmem(),
    turboConcurrency: process.env.TURBO_CONCURRENCY ?? null,
    status: 'running',
  };
  const save = () =>
    writeFile(
      join(directory, 'metadata.json'),
      `${JSON.stringify(metadata, null, 2)}\n`,
    );
  await save();
  console.log(`Benchmark artifacts: ${directory}`);
  try {
    if (plan.suite === 'workflows') {
      await run('pnpm', [
        'exec',
        'turbo',
        'run',
        'build',
        '--filter=@luma/workflows...',
      ]);
    }
    await run(binary, [
      '--shell=none',
      '--runs',
      String(plan.runs),
      '--warmup',
      String(plan.warmup),
      '--export-json',
      join(directory, 'results.json'),
      ...(plan.showOutput ? ['--show-output'] : []),
      plan.command,
    ]);
    metadata.status = 'passed';
  } catch (error) {
    metadata.status = 'failed';
    metadata.exitCode = error.exitCode ?? 1;
    throw error;
  } finally {
    metadata.finishedAt = new Date().toISOString();
    await save();
  }
} catch (error) {
  fail(error);
}
