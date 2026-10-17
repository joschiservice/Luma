# @luma/exceptions

Detection rules, incidents with their evidence, diagnosis, escalation and verification.
The rules are specified in the [exception taxonomy](../../docs/exception-taxonomy.md);
persistence and lifecycle in [exception detection](../../docs/exception-detection.md).
Scheduled detection, which reads providers and calls these rules, lives in
`@luma/resolution`.

## Rules and golden cases

- Rules evaluate normalized facts in `src/domain`, never provider payloads or database
  rows. Keep them pure; inject the clock.
- `fixtures/exceptions-v0.json` holds the acceptance vectors, and `golden.test.ts` requires
  the evaluator to reproduce every case. Changing a rule's decision changes a golden case.
  Keep positive, negative and uncertain coverage per class.
- An evaluation must stay reproducible from its stored versions. Adding an optional fact
  whose absence evaluates as before keeps the rule version. Changing behavior for existing
  inputs needs a new version. A threshold change needs a new configuration version; reusing
  a version with different values fails.
- Update the taxonomy with the rule, including its `Changes` entry for the version
  decision, as the existing entries do.

## Lifecycle traps

- Only two paths resolve an incident: a passed verification from the evaluator the
  composition installs, or a human disposition. Never accept verification results or
  success flags from a request, and never count a disposition as verified.
- Passing evidence must be complete, authoritative, independent of the detection evidence
  and observed at or after the latest detection. Anything else leaves the incident open.
- Resolved incidents are immutable. New evidence creates a linked successor.
- A clear or deferred decision never resolves an incident.
- Evidence keys identify immutable evidence. The same key with changed facts is a conflict,
  not an update. One advisory lock per tenant serializes evidence and resolution; keep
  external reads outside it.

## Tests

`pnpm --filter @luma/exceptions test <file>` for rules and validation. Persistence and
concurrency run against PostgreSQL in
`packages/application-runtime/src/exceptions.integration.test.ts`, through
`pnpm run test --filter=@luma/application-runtime -- exceptions.integration.test.ts`.
