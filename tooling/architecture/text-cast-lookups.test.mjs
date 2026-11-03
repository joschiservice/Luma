import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Casts that stay because something more selective already narrows the rows; each says what.
const allowed = JSON.parse(
  readFileSync(new URL('text-cast-lookups.json', import.meta.url), 'utf8'),
);
const excluded = new Set([
  'node_modules',
  'dist',
  'storybook-static',
  '.turbo',
]);
const skipped =
  /\.(test\.ts|e2e\.mjs|browser\.mjs|fixture\.ts)$|-fixture\.mjs$/;
// A key column cast to text on the left of a comparison, as SQL inside a source file writes it.
const cast = /(?<![\w'"])(?:[a-z_]+\.)?(?:id|[a-z_]+_id)::text\s*(?:=|IN\b)/g;

/** Lists the source files under a directory that can hold SQL. */
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return excluded.has(entry.name) ? [] : sourceFiles(path);

    return /\.(ts|tsx)$/.test(entry.name) && !skipped.test(entry.name)
      ? [path]
      : [];
  });
}

test('key columns are not cast to text for lookups', () => {
  const found = {};
  for (const directory of ['apps', 'packages'])
    for (const path of sourceFiles(join(root, directory))) {
      const count = readFileSync(path, 'utf8').match(cast)?.length;
      if (count) found[relative(root, path)] = count;
    }
  assert.deepEqual(
    found,
    Object.fromEntries(
      Object.entries(allowed).map(([path, { count }]) => [path, count]),
    ),
    'Compare the typed column with sqlUuid from @luma/platform; a cast keeps PostgreSQL off its index. See the add-migration skill.',
  );
});
