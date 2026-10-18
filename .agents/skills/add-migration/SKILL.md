---
name: add-migration
description: Add a PostgreSQL migration to Luma safely - numbering, tenant row-level security, runtime role grants, indexes under RLS, live-change triggers and testing. Use whenever a change adds or alters tables, columns, indexes, policies, grants, triggers or functions, in core, an app package or the simulator.
---

# Adding a migration

One shared runner applies migrations. It applies every pending file in a single transaction
under an advisory lock, records a checksum per file and refuses to start when an applied file
has changed. Runtime logins can never migrate; they get only the grants a migration gives
their group roles.

Read [tenant isolation](../../../docs/architecture/003-tenant-isolation-and-data-residency.md)
and the [database roles](../../../docs/development.md#database-roles) section first.

## 1. Choose the file

| Owner             | Directory                                 | Recorded as               |
| ----------------- | ----------------------------------------- | ------------------------- |
| Core domains      | `packages/application-runtime/migrations` | filename                  |
| A workspace app   | `packages/apps/<app-id>/migrations`       | `app:<app-id>/<filename>` |
| Simulator storage | `apps/simulator/migrations`               | `simulator_migrations`    |

- Core files are numbered: take the next four-digit number after the highest existing file
  and a short snake_case name (`0152_supplier_lead_times.sql`). If another branch lands the
  same number first, renumber yours before merging.
- App migrations run after all core migrations, in app directory and filename order. Provider
  migrations already in the core sequence stay there.
- Never edit, rename or delete a migration that has reached `main`; treat it as applied
  everywhere. Fix mistakes with a new migration.
- Start the file with a comment that explains why, as existing migrations do, especially for
  non-obvious grants, indexes and trade-offs.

## 2. Write it for one transaction

Everything pending runs in one transaction, so statements that refuse to run inside a
transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`) fail the whole run. Keep each migration
safe to apply to a database with existing tenant data: add columns as nullable or with a
default, and backfill in the same migration when the data is small enough.

## 3. Tenant-owned tables

Each domain owns writes to its tables. For a table that holds tenant data:

- `tenant_id uuid NOT NULL REFERENCES organizations(id)`, a primary key that starts with
  `tenant_id`, and composite foreign keys that include `tenant_id`, so rows can never point
  across tenants.
- Enable **and** force row-level security in the same migration that creates the table, with
  a `tenant_scope` policy for the owning domain's group role (the role its existing tables
  are granted to, such as `luma_desk` for procurement):

  ```sql
  ALTER TABLE supplier_lead_times ENABLE ROW LEVEL SECURITY;
  ALTER TABLE supplier_lead_times FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_scope ON supplier_lead_times TO luma_desk
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
  ```

  Migrations that create several tables loop over them with `format('... %I', relation)`;
  `0145_stock_protection.sql` is a recent example.

- Grant the owning group role only the DML it needs. Append-only data (revisions, events,
  audit) gets `SELECT, INSERT` only; grant column-level `UPDATE(column)` when one column
  changes. Never grant DDL, `TRUNCATE`, ownership or policy changes to runtime roles.
- Give read-only consumers `SELECT` and either add them to the policy
  (`ALTER POLICY tenant_scope ON <table> TO <owner>, <reader>`) or give them their own
  `FOR SELECT` policy. Column-level `GRANT SELECT(...)` keeps a reader to the columns it
  needs. Cross-domain reads go through deliberate query adapters, not shared write access.
- Classify the table for closed-workspace retention in the same migration:
  `INSERT INTO data_retention_classes(table_name,class) VALUES('supplier_lead_times','purge_on_closure');`
  Use `purge_on_closure` for workspace data, `keep_with_organization` for records that follow
  the organization or account lifecycle, and `legal_retention` only with a documented reason.
  Closed-workspace removal stops while any tenant table is unclassified, and the retention
  test fails first. Immutable tables attach the shared `refuse_delete_outside_purge()`
  trigger `BEFORE DELETE` rather than refusing deletes in their own guard.

A new group role must also be granted to the logins that need it: local logins in
`tooling/dev/database.mjs`, and journey fixtures that grant roles to their runtime login.

## 4. Indexes under RLS

Lead indexes with `tenant_id`. Row security keeps PostgreSQL from using indexes on JSON
expressions such as `document->>'kind'`, because `->>` is not leakproof. Store the key as a
`GENERATED ALWAYS AS (...) STORED` column and index that (see `0151_query_index_gaps.sql`).
Check the plan with `EXPLAIN` as a runtime role with `app.tenant_id` set; a superuser
bypasses RLS and shows a plan the API never gets.

## 5. Live updates and functions

- If the table feeds a metric, Home, Insights or Needs you, attach the `metric_change` trigger
  with the right topics; tables that feed Needs you also carry `decisions`. See
  [live delivery](../../../docs/operational-metrics.md#live-delivery).
- `SECURITY DEFINER` functions set `search_path`, `REVOKE ALL ... FROM PUBLIC`, and check that
  the row's `tenant_id` matches `app.tenant_id` before acting.

## 6. Test it

- `pnpm dev` applies pending migrations to this checkout's database. Never edit the database
  by hand to match a migration.
- Prove the behavior through the owning service with a database integration test in
  `packages/application-runtime/src/*.integration.test.ts`, or the owner's tests. Cover a
  second tenant that can't read or write the rows, and a runtime role that lacks the grant.
  Run one through the database runner with
  `pnpm run test --filter=@luma/application-runtime -- <file>`; it needs a Docker-compatible
  runtime. `pnpm --filter … test` runs Vitest without a database, and integration tests skip.

Finish with the [verify-change](../verify-change/SKILL.md) skill.
