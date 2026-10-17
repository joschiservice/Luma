# @luma/simulator

The simulator host: provider endpoints, the merchant world engine, failure injection,
webhook delivery, ground-truth incidents, the scorecard and the control API. See the
[README](README.md) and the [simulator guide](../../docs/simulator.md). To add an incident
kind with its detection and verification, use the `add-operational-scenario` skill.

## Boundaries

- Luma learns about simulated data only through its installed adapters, the commerce sync
  runner and signed webhook routes. Never add a shortcut that reads simulator records from
  Luma, or Luma tables from here; the databases and roles are separate on purpose.
- Provider protocol behavior belongs to `packages/simulator/<provider>`, merchant profiles
  to `@luma/simulator-commerce`, failure decisions and incident kinds to
  `@luma/simulator-core`. The engine in `src/engine` coordinates them.
- Simulator compatibility does not prove live-provider compatibility. Shopify's GraphQL
  schema covers the queries Luma sends; unknown fields fail as they would against Shopify.

## Determinism

- The same profile, chaos preset and seed must produce the same merchant. Draw randomness
  from `keyedRandom` in `@luma/simulator-core`, keyed by stable identities, never
  `Math.random` or the wall clock inside the engine.
- Failure decisions hash the seed, the request identity and how often that request was
  sent, so a retry gets a new decision. Keep that keying when adding transport faults.
- Response loss applies after a write commits. That order is what lets the scorecard's
  repeated-writes count catch a client that retries an uncertain write; keep it.

## Incidents and ground truth

- Ground truth stays here; Luma's case status is read from Luma through the pilot route.
- Injecting with a request ID the incident already has returns it unchanged. Recovery
  repairs the cause the way the merchant would and is safe to repeat.
- Incident resources must name the provider records or connection that Luma's evidence
  contains; the scorecard matches on them.
- The `test` profile holds fixed fixtures that platform tests rely on; changing it changes
  their baseline.

## Tests

`pnpm --filter @luma/simulator test <file>` runs engine and scorecard tests; host tests that
need PostgreSQL skip without `TEST_DATABASE_URL`. `pnpm test:simulator` provisions a
database and runs every simulator package. Platform journeys use `setupSimulator(t)` from
`apps/api/e2e/simulator-fixture.mjs`.
