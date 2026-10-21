import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, matchesGlob, relative, resolve } from 'node:path';

import {
  ignoredPaths,
  journeyAreas,
  sharedPaths,
} from '../../apps/api/e2e/journey-areas.mjs';
import { root } from './process.mjs';

const journeyDirectory = 'apps/api/e2e';
const suffixes = { e2e: '.e2e.mjs', browser: '.browser.mjs' };

/**
 * Runs git in the repository root and returns non-empty output lines.
 * @param {...string} args
 */
function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/** Lists backend and browser journey file names. */
export function journeyFiles() {
  return readdirSync(join(root, journeyDirectory))
    .filter((name) => Object.values(suffixes).some((s) => name.endsWith(s)))
    .sort();
}

/**
 * Returns the repository files a module loads through relative imports, including itself.
 * Package imports are not followed: every journey runs the whole application, so the areas a
 * journey exercises come from its declared journeyAreas instead.
 * @param {string} file repository-relative module path
 * @param {Set<string>} seen
 */
export function relativeImports(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(join(root, file))) return seen;
  seen.add(file);
  const source = readFileSync(join(root, file), 'utf8');
  for (const [, specifier] of source.matchAll(
    /(?:from|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  ))
    relativeImports(
      relative(root, resolve(root, dirname(file), specifier)),
      seen,
    );

  return seen;
}

/**
 * Lists files that differ between the merge base with `base` and the working tree, including
 * untracked files. Returns undefined when the history cannot establish a merge base, such as in
 * a shallow clone, so callers can run everything.
 * @param {string} base
 */
function changedFiles(base) {
  let mergeBase;
  try {
    [mergeBase] = git('merge-base', base, 'HEAD');
  } catch {
    return undefined;
  }

  return [
    ...new Set([
      ...git('diff', '--name-only', '--no-renames', mergeBase),
      ...git('ls-files', '--others', '--exclude-standard'),
    ]),
  ].sort();
}

/**
 * Chooses the journeys that exercise the changed files. A changed module selects the journeys
 * that import it; ignored paths select nothing; shared paths, and paths no journey declares,
 * select every journey so unmapped code is never left untested. Journeys declaring `**` boot the
 * whole system: they run with any declared change but do not count as coverage themselves.
 * @param {string[]} changed repository-relative paths
 * @param {{
 *   journeys: Record<string, { imports: Set<string>, areas: string[] }>,
 *   shared: string[],
 *   ignored: string[],
 * }} manifest
 * @returns {{ journeys: string[], reason?: string }}
 */
export function selectJourneys(changed, { journeys, shared, ignored }) {
  const names = Object.keys(journeys);
  const catchAll = names.filter((name) => journeys[name].areas.includes('**'));
  const selected = new Set();
  /**
   * Matches a path against specific patterns; `**` marks a boot journey, not coverage.
   * @type {(path: string, patterns: string[]) => boolean}
   */
  const matches = (path, patterns) =>
    patterns.some((pattern) => pattern !== '**' && matchesGlob(path, pattern));
  for (const path of changed) {
    const importing = names.filter((name) => journeys[name].imports.has(path));
    if (importing.length) {
      importing.forEach((name) => selected.add(name));
      continue;
    }
    if (matches(path, ignored)) continue;
    if (matches(path, shared))
      return { journeys: names, reason: `${path} is shared by every journey` };
    const covering = names.filter((name) =>
      matches(path, journeys[name].areas),
    );
    if (!covering.length)
      return { journeys: names, reason: `${path} is not mapped to a journey` };
    [...covering, ...catchAll].forEach((name) => selected.add(name));
  }

  return { journeys: names.filter((name) => selected.has(name)) };
}

/** Builds the selection manifest from journey files, their imports and declared areas. */
export function journeyManifest() {
  /** @type {Record<string, { imports: Set<string>, areas: string[] }>} */
  const journeys = {};
  /** @type {Record<string, string[]>} */
  const areas = journeyAreas;
  for (const name of journeyFiles()) {
    if (!Object.hasOwn(areas, name))
      throw new Error(`${journeyDirectory}/journey-areas.mjs: map ${name}`);
    journeys[name] = {
      imports: relativeImports(`${journeyDirectory}/${name}`),
      areas: areas[name],
    };
  }

  return { journeys, shared: sharedPaths, ignored: ignoredPaths };
}

/**
 * Selects backend and browser journeys affected by changes since the merge base with the
 * comparison base: TURBO_SCM_BASE, the pull request base in GitHub Actions, or `main`.
 * @returns {{ e2e: string[], browser: string[], reason?: string, changed: number }}
 */
export function affectedJourneys(env = process.env) {
  const base =
    env.TURBO_SCM_BASE ??
    (env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : 'main');
  const manifest = journeyManifest();
  const changed = changedFiles(base);
  const { journeys, reason } = changed
    ? selectJourneys(changed, manifest)
    : {
        journeys: Object.keys(manifest.journeys),
        reason: `no merge base with ${base}`,
      };

  // Timing scenarios run only in the performance suite, never in the journey suites.
  const functional = journeys.filter((name) => !name.includes('.performance.'));

  return {
    e2e: functional.filter((name) => name.endsWith(suffixes.e2e)),
    browser: functional.filter((name) => name.endsWith(suffixes.browser)),
    ...(reason ? { reason } : {}),
    changed: changed?.length ?? 0,
  };
}
