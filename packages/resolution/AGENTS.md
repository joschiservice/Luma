# @luma/resolution

The case desk and everything around a case after detection: scheduled detection monitors,
proposals and their refresh, decisions, follow-ups, Shadow Mode, learning, verified-outcome
measurement, activity and the operations overview. Rules and incident persistence belong to
`@luma/exceptions`; Temporal code belongs to `@luma/workflow-temporal`. See the
[README](README.md).

## Detection monitors

- `src/application/detection-monitor.ts` is the scheduled detection pass the sync worker
  and the pilot run. Stored state selects candidates; fresh provider reads decide. Keep per
  pass limits bounded, and keep rules independent so one unavailable source doesn't stop
  the others.
- Open cases are always reevaluated, and a clear result requests verification from the
  exceptions service. A monitor never resolves a case itself.
- `inventory-monitor.ts` shows the pattern for a new rule: explicit canonical mapping,
  complete provider pagination, confirmation of the exact mapped records, then the
  existing exception rule. See [scheduled detection](../../docs/exception-detection.md#scheduled-detection).
- Synthetic identifiers and scenario faults stay in simulator and pilot tooling.

## Desk and decisions

- GET reads return persisted state only. They never evaluate models or connector
  preconditions. Missing and foreign cases return the same 404.
- Decision commands carry a client `commandId`. Exact retries return the original receipt;
  a different body or actor with the same ID is a 409. Checks, approval, audit and the
  receipt share one transaction.
- Published proposals are immutable; a changed action needs a new proposal ID. No endpoint
  accepts arbitrary executable actions.
- Manual closure is a human disposition and never counts as verified. Shadow and
  observe-only outcomes never count as verified resolutions or live success metrics.
- Learning records are append-only; corrections are new events. They grant no authority.

Guides: [case decisions](../../docs/case-decisions.md), [case inbox](../../docs/case-inbox.md),
[Shadow Mode](../../docs/shadow-mode.md), [resolution learning](../../docs/resolution-learning.md)
and [verified outcomes](../../docs/resolution-measurement.md).

## Tests

`pnpm --filter @luma/resolution test <file>`. Build tenant contexts with `testContext` from
`src/application/tenant-context.fixture.ts` instead of constructing memberships by hand.
Desk, decision and live-update behavior is covered by backend journeys such as
`apps/api/e2e/decisions.e2e.mjs` and `apps/api/e2e/action-diffs.e2e.mjs`.
