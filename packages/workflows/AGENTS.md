# @luma/workflows

Workflow definitions, drafts, immutable versions, activations, triggers, runs and step
provenance, plus the `workflow/2` process interpreter and Code Steps. Read the
[workflow model](../../docs/workflows.md) first; Code Steps are in
[sandboxed Code Steps](../../docs/code-steps.md) and the legacy format in
[Resolution workflows](../../docs/resolution-playbooks.md).

## Boundaries

- This package must not depend on `@luma/resolution` or `@luma/exceptions`. Exception
  references are an optional specialization of a run.
- The root export is bundled into the Temporal workflow sandbox through `runProcess`. Keep
  the root export graph free of Node built-ins, database and provider access; those belong
  in `infrastructure` and `composition`.
- `runProcess` is the interpreter. Every read, decision, action and verification crosses a
  `ProcessActivities` boundary; the interpreter itself does no I/O.

## Invariants

- A version's digest covers its whole contract. Published versions are immutable, and a run
  binds the exact version, activation and digest. Never re-digest or rewrite stored
  versions; legacy versions keep `resolution-playbook/0` digests.
- Publication grants nothing. Every action goes through Action Admission by `runId` and
  `stepId`. `WorkflowActor` is provenance, not permission; reject caller-supplied actor
  fields.
- All authoring modes edit the same `workflow/2` draft and publish through one path. Don't
  add a mode-specific engine or permission path.
- A version no installed adapter can run is shown as unavailable and cannot be activated.
  Trigger metadata does not install a handler.
- Step outputs are append-only per run, step and state. Failed verification ends the run;
  exhausted inconclusive rechecks end inconclusive, never verified.
- Start the Temporal run only after the trigger run commits, and signal a decision only
  after its record commits.
- The `playbook_*` tables hold native and legacy definitions behind a format discriminator.

## Tests

`pnpm --filter @luma/workflows test <file>`. Process fixtures live beside the domain as
`*.fixture.ts`. Code Step tests need the runtime from `pnpm setup:code`; without it they
skip. `pnpm verify:feature workflows` runs the focused checks and workflow journeys.
