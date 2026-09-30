# ADR-008: Workspace read models

Status: accepted. Decision: 2026-09-29.

## Context

The record explorer, order metrics composition, operational summary and Orders workspace
answer questions that span owners: an order, its issues, its workflow runs and its
activity. They lived in `@luma/resolution` and used raw SQL over tables owned by orders,
connectors, exceptions and workflows. Resolution was turning into a catch-all read layer,
and business rules were restated in several places. "Open" and "overdue" existed in the
order metrics SQL, the Orders list SQL and TypeScript domain code; only an integration test
kept them equal.

ADR-001 allows cross-owner reads through owner interfaces or an explicitly owned
projection. Owner method calls cannot share one repeatable-read snapshot across owners, and
paging or counting across them in application code does not scale. A maintained per-order
projection would duplicate write paths before there is evidence that it is needed.

## Decision

`@luma/read-models` owns read-only workspace views: the record explorer, order and
operational metrics composition, the operational summary, the Orders workspace and the
Needs you decision queue. The queue also accepts owner-presented decisions from providers
that the composition root injects (procurement replenishment and installed apps); responses
stay with those owners.

- It never writes. It runs each request in one read-only, repeatable-read transaction under
  the API login and relies on each table's tenant row security.
- Business rules stay with their owners. Owners export SQL building blocks through their
  `composition` entry point, and the application composition root injects them:
  - `@luma/orders` `orderStateQueries`: current order sources, the source selection order,
    line progress, fulfillment state and `orders.open`/`orders.overdue` v1. The order
    metrics use the same blocks.
  - `@luma/exceptions` `orderAttentionQuery`: the inbox attention rule for orders
    (`orders.attention` v1).
- Rules that exist only for a view, such as "differs by source" in Orders, live in the read
  model and are written once in SQL for both list and detail.
- Owners' public `index.ts` exports only the types of these building blocks
  (`OrderStateQueries`). Fragments document the parameters they bind (`$1` tenant, `$2`
  evaluation time).
- The module may import platform, identity, orders, exceptions, connectors, procurement and resolution
  (see `tooling/architecture/policy.mjs`). Nothing imports it except composition roots.

Resolution keeps diagnosis, case coordination, learning, activity and the operations
overview.

## Consequences

- One definition per rule; parity tests remain as a regression check, not as the only link.
- Owners that change a table used by a building block update the SQL they export. Direct
  table reads that remain in the read model (mappings, installations, run and activity
  lookups) are listed in its queries and covered by integration tests.
- Existing read grants (`luma_case_reader`, `luma_desk`) are unchanged. Narrowing them to
  the read model's exact tables is a separate migration.
- Row security keeps PostgreSQL from using indexes for conditions with non-leakproof
  functions, which includes `ILIKE` and JSON operators such as `->>`. Lookup keys inside JSON
  documents are stored as generated columns with btree indexes. Substring search scans the
  tenant's current rows.

Reversal cost is low: the package is a move plus injected SQL. See
[Orders workspace](../orders-workspace.md) for the read model and measurements.
