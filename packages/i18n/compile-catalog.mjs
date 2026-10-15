import * as fs from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { writeOutput } from '@inlang/paraglide-js';
import { loadProjectFromDirectory } from '@inlang/sdk';

import { compileCatalogOutput } from './compile-output.mjs';
import {
  compilerOptions,
  productionCompilerOptions,
} from './compiler-options.mjs';

const lock = new URL('./dist/.compile-lock', import.meta.url);
const staleLockMs = 60_000;
let queue = Promise.resolve();

async function compileOnce(options) {
  const staging = `${options.outdir}.${process.pid}`;
  const retired = `${staging}.old`;
  await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt > 600) throw error;
      // A process killed mid-build (such as a dev server stopped by a test) leaves its lock
      // behind. A build takes seconds, so an older lock no longer protects anything.
      const held = await stat(lock).catch(() => undefined);
      if (held && Date.now() - held.mtimeMs > staleLockMs) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    // Staging and retired directories of a process that was killed mid-build are safe to
    // remove while this process holds the lock.
    const parent = path.dirname(options.outdir);
    const prefix = `${path.basename(options.outdir)}.`;
    for (const entry of await readdir(parent))
      if (entry.startsWith(prefix))
        await rm(path.join(parent, entry), { recursive: true, force: true });
    const project = await loadProjectFromDirectory({
      path: options.project,
      fs,
    });
    try {
      const output = await compileCatalogOutput(project, options);
      await writeOutput({ directory: staging, output, fs: fs.promises });
      for (const warning of await project.errors.get()) console.warn(warning);
    } finally {
      await project.close();
    }
    await rename(options.outdir, retired).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rename(staging, options.outdir);
    await rm(retired, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

/**
 * Compiles the message catalogs into the shared runtime, or with `production` into the separate
 * per-message runtime that production builds bundle. Builds in other processes take turns
 * through a lock directory, calls in this process run one after another, and each build is
 * written to a staging directory and swapped into place, so readers never see a half-written
 * runtime.
 */
export function compileCatalog({ production = false } = {}) {
  const next = queue.then(() =>
    compileOnce(production ? productionCompilerOptions : compilerOptions),
  );
  // A failed build must not block the next one; the caller still sees the failure.
  queue = next.catch(() => undefined);

  return next;
}
