# Playbook release evaluation

Run `pnpm evaluate:playbook` to evaluate the pinned shipping-method Playbook against the versioned JTL/Shopify corpus. Exit code 0 means every scenario passed; any mismatch exits 1. CI runs the gate and uploads its report.

```sh
pnpm evaluate:playbook --candidate candidate.json --corpus corpus.json --output .luma/evaluations/candidate.json
pnpm test:evaluation
```

The candidate is a compiled `PlaybookVersion`, including its content digest. Use `compilePlaybook` from `@luma/resolution/composition` to compile a source definition. The evaluator recomputes and checks the digest. The checked-in candidate pins the current shipping-method Playbook; update it deliberately when that definition changes.

The report records the candidate hash, corpus version and hash, interpreter/admission versions, capability and adapter versions, and each fixture's version and hash. Scenario traces include capability calls, observations, interpreter outcomes, provider journal, execution reservations, policy decisions, approvals, failures and verification attempts. Identical inputs produce identical JSON. Reports are written atomically with private file permissions.

## Fixture contract

`fixtures/corpus.json` contains shared `fixture` inputs and an ordered `scenarios` array. A scenario overrides top-level shared fields; `incident` overrides individual incident fields. All other nested values replace their shared value completely. The resulting fixture is hashed before replay.

Each reconstructed fixture contains:

- `id`, `version`, and `incident.provenance`: stable identity and source reference.
- `provider`: initial serialized JTL/Shopify simulator state, clock, and fault rules.
- `incident`: evidence snapshot, proposed action, connection/target grants, external-ID mapping, authority reference, diagnosis revision/status/cause, and initial capability reads. Use `null` for an unknown cause.
- `controls.commands`: ordered `execute`, `approve`, `reject`, `reconcile`, `restart`, `foreign-tenant`, or `advance` commands (`advance` includes `ms`).
- `controls`: optional verification delay, external change before verification, or interruption before execution completion is persisted.
- `expected`: exact ordered capability calls (including input, connection, tenant, version and idempotency key), provider PATCH requests, interpreter outcome sequence, and final JTL shipping method.

Expectations are reviewed fixtures, never regenerated from a candidate's output. Unexpected capability calls and provider writes are rejected before dispatch and retained as violations even if execution catches the error. Missing calls, additional calls, wrong ordering, incorrect outcomes and Shopify state changes fail the gate.

The corpus covers successful correction, approval denial, stale evidence, replay/idempotency, tenant isolation, lost response after commit, uncertain dispatch without commit, verification outage after a successful write, delayed/failed verification, exceeded verification windows, and worker restart with a persisted reservation.

## Capture a historical incident

Export the authorized incident history and reconstruct its **initial** provider state and evidence snapshot. Preserve the original timestamps, mappings, authority and known diagnosis/cause. Supply reviewed expectations for the intended behavior. The learning history alone does not contain a complete provider snapshot; obtain missing facts from retained incident evidence rather than assuming current provider state was the initial state.

Create an input JSON object with:

```json
{
  "corpusVersion": "shipping-incidents/1",
  "fixture": "<complete reconstructed fixture object described above>",
  "history": {
    "reference": "<retained incident or export reference>",
    "playbook": "<original compiled PlaybookVersion object>",
    "actionSequence": ["<original ProposedAction objects in order>"],
    "observations": ["<retained resulting observations>"],
    "outcome": "<retained outcome object>"
  }
}
```

The strings in angle brackets describe objects to supply, not literal values. Then run:

```sh
pnpm capture:incident reconstructed-incident.json historical-corpus.json
pnpm evaluate:playbook --candidate original-version.json --corpus historical-corpus.json
```

Capture validates the original Playbook hash, snapshot, action tenant and membership in the retained action sequence. It preserves the source history and its hash, and refuses to overwrite an existing corpus file. Replay can use the original exact version or a separately pinned candidate to compare behavior against the same reviewed expectations. Keep sensitive incident exports and reports outside Git; `.luma/` is ignored.

## Execution boundary

The harness calls production Playbook, admission, policy/approval, execution, shipping-effect, capability-runtime and JTL/Shopify connector code. Only persistence, identity refresh and incident eligibility data use isolated fixture adapters. Both providers use the existing stateful simulators through an injected transport; no credentials or live endpoints are used.

A restart serializes the complete provider/persistence/ID checkpoint to JSON and constructs fresh services. This tests recovery of durable reservations and read-only reconciliation. Database transactions and Temporal event-history replay remain covered by their integration suites. The checked-in corpus is synthetic; historical cases enter through the capture command.

## Code Step replay

Run `pnpm setup:code`, then `pnpm evaluate:code [corpus.json] [report.json]` to evaluate a pinned Code Step with ordered fixture replies. The default corpus is `fixtures/code-corpus.json`. Every scenario runs twice; outputs, request order and input digests must agree. Reports exclude wall-time and memory measurements. See [Code Steps](../../docs/code-steps.md) for runtime installation, capability grants and deployment limits.
