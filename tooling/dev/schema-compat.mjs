import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  changedMigrations,
  comparisonBase,
  migrationFiles,
} from './migration-contract.mjs';
import { fail, root, run } from './process.mjs';

// Runs the previous release's backend journeys against this checkout's schema. A failed deploy
// rolls back to the previous image without undoing migrations, so that code must work on the new
// schema. The base release is checked out in a separate worktree, receives this checkout's
// migration files, and its own test harness migrates one template database with all of them.

const usage = `Usage: pnpm test:schema-compat [--base <ref>] [--directory <path>] [--force] [--dry-run] [-- <journey filters>]

Checks out <ref> (default: the pull request base, TURBO_SCM_BASE or origin/main) in a temporary
worktree, copies this checkout's core and app migrations into it, installs it and runs its backend
journeys. Exits early when no migration changed since the merge base, unless --force is given.
--dry-run stops after copying and lists the copied files. The worktree is always removed.`;

/**
 * Copies every core and app migration from `source` into `target`, creating app migration
 * directories the target lacks. Files only the target has are left in place. Returns the paths
 * that were new or different in the target.
 * @param {string} source
 * @param {string} target
 */
export function copyMigrations(source, target) {
  const copied = [];
  for (const file of migrationFiles(source)) {
    const content = readFileSync(join(source, file));
    const destination = join(target, file);
    if (existsSync(destination) && readFileSync(destination).equals(content))
      continue;
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
    copied.push(file);
  }

  return copied;
}

/**
 * Parses command-line options; arguments after `--` are journey filters for `pnpm test:e2e`.
 * @param {string[]} argv
 */
export function parseOptions(argv) {
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const filters = separator === -1 ? [] : argv.slice(separator + 1);
  const valued = ['--base', '--directory'];
  const flags = ['--force', '--dry-run', '--help'];
  for (let index = 0; index < own.length; index++) {
    if (
      valued.includes(own[index]) &&
      own[index + 1] &&
      !own[index + 1].startsWith('--')
    )
      index++;
    else if (valued.includes(own[index]))
      throw new Error(`${own[index]} needs a value`);
    else if (!flags.includes(own[index]))
      throw new Error(`Unknown argument ${own[index]}\n\n${usage}`);
  }
  const value = (/** @type {string} */ name) =>
    own.includes(name) ? own[own.indexOf(name) + 1] : undefined;

  return {
    base: comparisonBase(own),
    directory: value('--directory'),
    force: own.includes('--force'),
    dryRun: own.includes('--dry-run'),
    help: own.includes('--help'),
    filters,
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log(usage);

    return;
  }
  const changed = changedMigrations(options.base);
  if (!changed.length && !options.force) {
    console.log(
      `No migration changed since ${options.base}; nothing to check.`,
    );

    return;
  }
  console.log(
    `Migrations changed since ${options.base}: ${changed.join(', ') || 'none (forced)'}.`,
  );

  // The worktree must not exist yet; a temporary parent keeps it out of this checkout.
  const parent = options.directory
    ? undefined
    : mkdtempSync(join(tmpdir(), 'luma-schema-compat-'));
  const checkout = options.directory
    ? resolve(options.directory)
    : join(String(parent), 'base');
  await run('git', ['worktree', 'add', '--detach', checkout, options.base]);
  try {
    const copied = copyMigrations(root, checkout);
    console.log(
      `Copied ${copied.length} new or changed migration file(s) into ${options.base}:\n${copied.map((file) => `  ${file}`).join('\n')}`,
    );
    if (options.dryRun) {
      await run('git', ['status', '--short'], { cwd: checkout });

      return;
    }
    const env = { ...process.env };
    // The base checkout's own validation lock and comparison base apply, not this checkout's.
    delete env.LUMA_VALIDATION_OWNER;
    delete env.TURBO_SCM_BASE;
    await run('pnpm', ['install', '--frozen-lockfile'], { cwd: checkout, env });
    await run('pnpm', ['setup:code'], { cwd: checkout, env });
    await run('pnpm', ['test:e2e', ...options.filters], { cwd: checkout, env });
  } finally {
    await run('git', ['worktree', 'remove', '--force', checkout]);
    if (parent) rmSync(parent, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main().catch(fail);
