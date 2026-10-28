import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkMigration,
  comparisonBase,
  isMigration,
  splitStatements,
} from './migration-contract.mjs';

/** Lists the changes found in a migration, without line numbers. */
const changes = (/** @type {string} */ sql) =>
  checkMigration(sql).map(({ change }) => change);

test('flags statements that break the previous release', () => {
  const cases = {
    'DROP TABLE IF EXISTS supplier_notes;': 'drops a table',
    'DROP VIEW open_orders;': 'drops a view',
    'DROP MATERIALIZED VIEW stock_totals;': 'drops a materialized view',
    'DROP FUNCTION erase_customer(uuid);': 'drops a function',
    'DROP TYPE order_state;': 'drops a type',
    'ALTER TABLE orders DROP COLUMN note;': 'drops a column',
    'ALTER TABLE orders DROP note;': 'drops a column',
    'ALTER TABLE orders RENAME COLUMN note TO memo;':
      'renames a table or column',
    'ALTER TABLE orders RENAME TO sales_orders;': 'renames a table or column',
    'ALTER TABLE orders ALTER COLUMN total TYPE numeric(12,2);':
      "changes a column's type",
    'ALTER TABLE orders ALTER total SET DATA TYPE bigint;':
      "changes a column's type",
    'ALTER TABLE orders ALTER COLUMN note SET NOT NULL;':
      'makes a column required',
    'ALTER TABLE orders ALTER COLUMN state DROP DEFAULT;':
      "drops a column's default",
    'ALTER TABLE orders ADD COLUMN request_id uuid NOT NULL REFERENCES requests(id);':
      'adds a required column without a default',
    'ALTER FUNCTION purge(integer) RENAME TO purge_messages;':
      'renames a function',
    "ALTER TYPE order_state RENAME VALUE 'open' TO 'pending';":
      'renames a type',
    'ALTER TABLE orders SET SCHEMA archive;': 'moves a table to another schema',
  };
  for (const [sql, change] of Object.entries(cases))
    assert.deepEqual(changes(sql), [change], sql);
});

test('allows additive and constraint changes', () => {
  const sql = `
    CREATE TABLE notes (id uuid PRIMARY KEY, body text NOT NULL);
    ALTER TABLE orders ADD COLUMN note text;
    ALTER TABLE orders ADD COLUMN memo text CHECK (memo IS NOT NULL OR note IS NULL);
    ALTER TABLE orders ADD COLUMN state text NOT NULL DEFAULT 'open';
    ALTER TABLE orders ADD COLUMN key text GENERATED ALWAYS AS (document->>'key') STORED;
    ALTER TABLE orders ADD CONSTRAINT orders_state CHECK (state IS NOT NULL);
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_state_old;
    ALTER TABLE orders ALTER COLUMN note DROP NOT NULL, ALTER COLUMN state SET DEFAULT 'open';
    ALTER TABLE orders RENAME CONSTRAINT a TO b;
    ALTER INDEX orders_state SET (fillfactor = 90);
    DROP INDEX IF EXISTS orders_note;
    DROP POLICY tenant_scope ON orders;
    DROP TRIGGER orders_change ON orders;
  `;
  assert.deepEqual(changes(sql), []);
});

test('reports each breaking action of a multi-action ALTER TABLE once', () => {
  const sql = `ALTER TABLE orders
    ADD COLUMN note text,
    DROP COLUMN memo,
    ALTER COLUMN total TYPE numeric(12, 2) USING total::numeric(12, 2),
    DROP COLUMN legacy;`;
  assert.deepEqual(changes(sql), ['drops a column', "changes a column's type"]);
});

test('ignores comments, strings and function bodies', () => {
  const sql = `
    -- We used to DROP TABLE orders; never again.
    /* ALTER TABLE orders DROP COLUMN note; /* nested */ still a comment */
    COMMENT ON TABLE orders IS 'Do not DROP TABLE; it''s shared';
    SELECT E'escaped \\' DROP TABLE x;';
    CREATE FUNCTION purge() RETURNS void LANGUAGE plpgsql AS $fn$
    BEGIN
      DROP TABLE scratch;
      EXECUTE 'ALTER TABLE orders DROP COLUMN note';
    END $fn$;
  `;
  assert.deepEqual(changes(sql), []);
});

test('searches DO blocks, including their dynamic SQL', () => {
  const sql = `DO $$
    DECLARE relation text;
    BEGIN
      FOREACH relation IN ARRAY ARRAY['orders','returns'] LOOP
        EXECUTE format('ALTER TABLE %I DROP COLUMN note', relation);
        RAISE NOTICE 'not a DROP TABLE';
      END LOOP;
    END $$;`;
  assert.deepEqual(changes(sql), ['drops a column']);
});

test('a contract marker directly above a statement allows it', () => {
  const sql = `
    -- contract: release 2026.10 stopped reading orders.note.
    ALTER TABLE orders DROP COLUMN note;

    ALTER TABLE orders DROP COLUMN memo;
  `;
  assert.deepEqual(checkMigration(sql), [
    { line: 5, change: 'drops a column' },
  ]);
});

test('a contract marker needs a reason and covers only the next statement', () => {
  assert.deepEqual(changes('-- contract:\nDROP TABLE notes;'), [
    'drops a table',
  ]);
  assert.deepEqual(
    changes(`
      -- contract: notes moved to supplier_notes two releases ago.
      DROP TABLE notes;
      DROP TABLE notes_archive;
    `),
    ['drops a table'],
  );
  assert.deepEqual(
    changes(`ALTER TABLE orders
      -- contract: inside a statement does not count.
      DROP COLUMN note;`),
    ['drops a column'],
  );
});

test('statements keep their starting line across comments and bodies', () => {
  const statements = splitStatements(
    "-- one\nSELECT 1;\n\nCREATE FUNCTION f() RETURNS int AS $$\nSELECT 1;\n$$ LANGUAGE sql;\nSELECT ';';",
  );
  assert.deepEqual(
    statements.map(({ line, comments }) => [line, comments]),
    [
      [2, ['-- one']],
      [4, []],
      [7, []],
    ],
  );
});

test('checks only core and app migration files', () => {
  assert.ok(isMigration('packages/application-runtime/migrations/0170_x.sql'));
  assert.ok(isMigration('packages/apps/jtl/migrations/0003_x.sql'));
  assert.ok(!isMigration('apps/simulator/migrations/0005_x.sql'));
  assert.ok(!isMigration('packages/apps/jtl/src/migrations/x.sql'));
  assert.ok(!isMigration('packages/application-runtime/migrations/README.md'));
});

test('compares with the pull request base unless told otherwise', () => {
  assert.equal(comparisonBase([], {}), 'origin/main');
  assert.equal(comparisonBase([], { GITHUB_BASE_REF: 'dev' }), 'origin/dev');
  assert.equal(
    comparisonBase([], { GITHUB_BASE_REF: 'dev', TURBO_SCM_BASE: 'HEAD' }),
    'HEAD',
  );
  assert.equal(comparisonBase(['--base', 'v1.2.0'], {}), 'v1.2.0');
  assert.throws(() => comparisonBase(['--base'], {}), /needs a git ref/);
});
