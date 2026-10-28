import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { fail, root } from './process.mjs';

// A deploy that fails its health checks rolls back to the previous image, but migrations only go
// forward, so the previous release must keep working on the new schema (expand/contract). This
// check rejects statements that remove or narrow what the previous release reads or writes,
// unless a `-- contract:` comment directly above the statement explains why that is safe.

const marker = /^--\s*contract:\s*\S/i;

// Statements written before this check existed. Their files are applied and checksummed, so a
// marker cannot be added. No cell was deployed when the check was added, so no earlier release
// can run against them.
// Never add to this list: mark new statements instead.
const accepted = new Set([
  'packages/application-runtime/migrations/0043_product_catalog.sql:30',
  'packages/application-runtime/migrations/0094_customer_order_addresses.sql:30',
  'packages/application-runtime/migrations/0112_supplier_outgoing_mail.sql:16',
  'packages/application-runtime/migrations/0134_regional_cells.sql:14',
  'packages/application-runtime/migrations/0152_staff_inspection_records.sql:85',
  'packages/application-runtime/migrations/0152_staff_inspection_records.sql:86',
  'packages/application-runtime/migrations/0163_customer_erasure.sql:195',
]);
const droppedKinds =
  'TABLE|VIEW|MATERIALIZED\\s+VIEW|FUNCTION|PROCEDURE|TYPE|DOMAIN|SEQUENCE|SCHEMA';
const constraintWords = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'UNIQUE',
  'CHECK',
  'FOREIGN',
  'EXCLUDE',
]);

/**
 * A top-level SQL statement. `code` has comments removed, string literals emptied and
 * dollar-quoted bodies replaced by `$$`; `bodies` holds those bodies; `comments` holds the line
 * comments between the previous statement and this one.
 * @typedef {{ code: string, line: number, comments: string[], bodies: string[] }} Statement
 */

/**
 * Splits a migration into top-level statements, keeping the line comments that precede each
 * one. Handles line and nested block comments, single-quoted and E'' strings, quoted identifiers
 * and dollar-quoted bodies, so semicolons and keywords inside them neither split statements nor
 * match rules.
 * @param {string} sql
 * @returns {Statement[]}
 */
export function splitStatements(sql) {
  /** @type {Statement[]} */
  const statements = [];
  let code = '';
  let line = 1;
  let start = 0;
  /** @type {string[]} */
  let comments = [];
  /** @type {string[]} */
  let bodies = [];
  let i = 0;
  const finish = () => {
    if (code.trim()) statements.push({ code, line: start, comments, bodies });
    code = '';
    comments = [];
    bodies = [];
  };
  /** Advances past `text`, counting its line breaks. */
  const skip = (/** @type {string} */ text) => {
    line += text.split('\n').length - 1;
    i += text.length;
  };

  while (i < sql.length) {
    const rest = sql.slice(i);
    const char = sql[i];
    if (rest.startsWith('--')) {
      const end = rest.indexOf('\n');
      const comment = end === -1 ? rest : rest.slice(0, end);
      // Comments inside a statement do not mark it; only those before it do.
      if (!code.trim()) comments.push(comment.trim());
      skip(comment);
      continue;
    }
    if (rest.startsWith('/*')) {
      let depth = 0;
      let j = 0;
      do {
        if (rest.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (rest.startsWith('*/', j)) {
          depth--;
          j += 2;
        } else j++;
      } while (depth > 0 && j < rest.length);
      skip(rest.slice(0, j));
      code += ' ';
      continue;
    }
    if (!code.trim() && !/\s/.test(char)) start = line;
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '')) {
      const end = rest.indexOf(dollar[0], dollar[0].length);
      const length = end === -1 ? rest.length : end + dollar[0].length;
      bodies.push(rest.slice(dollar[0].length, end === -1 ? undefined : end));
      skip(rest.slice(0, length));
      code += '$$';
      continue;
    }
    if (char === "'") {
      const escapes = /[Ee]$/.test(code) && !/[A-Za-z0-9_][Ee]$/.test(code);
      let j = 1;
      while (j < rest.length) {
        if (escapes && rest[j] === '\\') j += 2;
        else if (rest[j] === "'" && rest[j + 1] === "'") j += 2;
        else if (rest[j] === "'") break;
        else j++;
      }
      skip(rest.slice(0, j + 1));
      code += "''";
      continue;
    }
    if (char === '"') {
      const end = rest.indexOf('"', 1);
      const text = end === -1 ? rest : rest.slice(0, end + 1);
      skip(text);
      code += text;
      continue;
    }
    if (char === ';') {
      i++;
      finish();
      continue;
    }
    if (char === '\n') line++;
    code += char;
    i++;
  }
  finish();

  return statements;
}

/**
 * Splits on commas outside parentheses, as ALTER TABLE separates its actions.
 * @param {string} text
 */
function topLevelParts(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const char of text) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += char;
  }
  parts.push(current.trim());

  return parts;
}

/**
 * Names what an ALTER TABLE action removes or narrows for the previous release, or undefined.
 * @param {string} action normalized, upper-case action text
 */
function alterTableAction(action) {
  const drop = /^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?("[^"]+"|\S+)/.exec(
    action,
  );
  if (drop && drop[1] !== 'CONSTRAINT') return 'drops a column';
  const column = /^ALTER\s+(?:COLUMN\s+)?(?:"[^"]+"|\S+)\s+(.*)$/.exec(action);
  if (column) {
    if (/^(?:SET\s+DATA\s+)?TYPE\b/.test(column[1]))
      return "changes a column's type";
    if (/^SET\s+NOT\s+NULL\b/.test(column[1])) return 'makes a column required';
    if (/^DROP\s+DEFAULT\b/.test(column[1])) return "drops a column's default";
  }
  const add =
    /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|\S+)/.exec(action);
  if (
    add &&
    !constraintWords.has(add[1]) &&
    /(?<!\bIS\s)\bNOT\s+NULL\b/.test(action) &&
    !/\b(?:DEFAULT|GENERATED)\b/.test(action)
  )
    return 'adds a required column without a default';
  if (/^RENAME\b/.test(action) && !/^RENAME\s+CONSTRAINT\b/.test(action))
    return 'renames a table or column';
  if (/^SET\s+SCHEMA\b/.test(action)) return 'moves a table to another schema';

  return undefined;
}

/**
 * Lists what a statement removes or narrows that the previous release may still use. DO blocks
 * run during the migration, so their bodies are searched too, including dynamic SQL in strings;
 * function bodies run later and are ignored.
 * @param {Pick<Statement, 'code' | 'bodies'>} statement
 * @returns {string[]}
 */
function breakingChanges({ code, bodies }) {
  const text = code.replace(/\s+/g, ' ').trim().toUpperCase();
  const found = [];
  const dropped = new RegExp(`^DROP\\s+(${droppedKinds})\\b`).exec(text);
  if (dropped) found.push(`drops a ${dropped[1].toLowerCase()}`);
  const table =
    /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:"[^"]+"|\S+)\s+(.*)$/.exec(
      text,
    );
  if (table)
    for (const action of topLevelParts(table[1])) {
      const change = alterTableAction(action);
      if (change) found.push(change);
    }
  else {
    const altered = new RegExp(`^ALTER\\s+(${droppedKinds})\\b`).exec(text);
    if (altered && /\bRENAME\b(?!\s+CONSTRAINT\b)/.test(text))
      found.push(`renames a ${altered[1].toLowerCase()}`);
    else if (altered && /\bSET\s+SCHEMA\b/.test(text))
      found.push(`moves a ${altered[1].toLowerCase()} to another schema`);
  }
  if (/^DO\b/.test(text))
    for (const body of bodies)
      for (const nested of splitStatements(body.replace(/'/g, ' ')))
        for (const part of nested.code.split(/\bEXECUTE\b|\bFORMAT\s*\(/i))
          found.push(...breakingChanges({ code: part, bodies: [] }));

  return [...new Set(found)];
}

/**
 * Checks one migration file. A statement that breaks the previous release passes only when a
 * `-- contract: <reason>` comment sits among the comments directly above it.
 * @param {string} sql
 * @returns {{ line: number, change: string }[]}
 */
export function checkMigration(sql) {
  return splitStatements(sql).flatMap((statement) =>
    statement.comments.some((comment) => marker.test(comment))
      ? []
      : breakingChanges(statement).map((change) => ({
          line: statement.line,
          change,
        })),
  );
}

/** Whether a repository path is a core or app migration the shared runner applies. */
export function isMigration(/** @type {string} */ path) {
  return /^packages\/(?:application-runtime|apps\/[^/]+)\/migrations\/[^/]+\.sql$/.test(
    path,
  );
}

/**
 * Runs git in the repository root and returns non-empty output lines.
 * @param {...string} args
 */
function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/**
 * Lists the core and app migration files of a checkout, as sorted repository-relative paths.
 * @param {string} checkout
 */
export function migrationFiles(checkout = root) {
  const directories = [
    'packages/application-runtime/migrations',
    ...readdirSync(join(checkout, 'packages/apps'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/apps/${entry.name}/migrations`),
  ];

  return directories
    .flatMap((directory) => {
      try {
        return readdirSync(join(checkout, directory)).map(
          (name) => `${directory}/${name}`,
        );
      } catch {
        return [];
      }
    })
    .filter(isMigration)
    .sort();
}

/**
 * Lists migrations added or changed since the merge base with `base`, including uncommitted and
 * untracked files. Throws when git cannot find a merge base.
 * @param {string} base
 */
export function changedMigrations(base) {
  let mergeBase;
  try {
    [mergeBase] = git('merge-base', base, 'HEAD');
  } catch {
    throw new Error(
      `No merge base with ${base}. Fetch it, or choose another with --base <ref> or --all.`,
    );
  }
  const paths = ['packages/application-runtime/migrations', 'packages/apps'];

  return [
    ...new Set([
      ...git(
        'diff',
        '--name-only',
        '--diff-filter=d',
        mergeBase,
        '--',
        ...paths,
      ),
      ...git('ls-files', '--others', '--exclude-standard', '--', ...paths),
    ]),
  ]
    .filter(isMigration)
    .sort();
}

/**
 * Chooses the comparison base: `--base <ref>`, TURBO_SCM_BASE, the pull request base in GitHub
 * Actions, or `origin/main`.
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
export function comparisonBase(args, env = process.env) {
  const flag = args.indexOf('--base');
  if (flag !== -1) {
    const ref = args[flag + 1];
    if (!ref) throw new Error('--base needs a git ref');

    return ref;
  }

  return (
    env.TURBO_SCM_BASE ??
    (env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : 'origin/main')
  );
}

function main() {
  const args = process.argv.slice(2);
  const all = args.includes('--all');
  const base = all ? undefined : comparisonBase(args);
  const files = all ? migrationFiles() : changedMigrations(String(base));
  const problems = files.flatMap((file) =>
    checkMigration(readFileSync(join(root, file), 'utf8'))
      .filter(({ line }) => !accepted.has(`${file}:${line}`))
      .map(({ line, change }) => `${file}:${line}: ${change}`),
  );
  if (problems.length) {
    console.error(
      [
        'These migration statements break the previous release, which keeps running during the',
        'deploy and returns on rollback:',
        ...problems.map((problem) => `  ${problem}`),
        'Expand first and contract in a later release, or, once no deployed release uses what the',
        'statement removes, put `-- contract: <why the previous release no longer needs it>`',
        'directly above it. See .agents/skills/add-migration/SKILL.md.',
      ].join('\n'),
    );
    process.exitCode = 1;

    return;
  }
  console.log(
    `Migration contract: ${files.length} ${all ? '' : `changed since ${base} `}file(s) keep the previous release working.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    fail(error);
  }
}
