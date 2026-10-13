# Release evaluations

Deterministic evaluation gates for Playbooks, Code Steps and workflow authoring. CI runs the Playbook gate and uploads its report.

## Playbook evaluation

`pnpm evaluate:playbook` evaluates the pinned shipping-method Playbook against the versioned JTL and Shopify corpus. Exit code 0 means every scenario passed; any mismatch exits 1. `pnpm test:evaluation` tests the evaluators themselves.

```sh
pnpm evaluate:playbook --candidate candidate.json --corpus corpus.json --output .luma/evaluations/candidate.json
```

The candidate is a compiled `PlaybookVersion`, including its content digest; compile a source definition with `compilePlaybook` from `@luma/resolution/composition`. The evaluator recomputes and checks the digest. The checked-in `fixtures/candidate.json` pins the current shipping-method Playbook; update it deliberately when that definition changes.

The report records the candidate, corpus and fixture hashes and the interpreter, admission, capability and adapter versions. Scenario traces include capability calls, observations, interpreter outcomes, the provider journal, execution reservations, policy decisions, approvals, failures and verification attempts. Identical inputs produce identical JSON. Reports are written atomically with private file permissions.

### Fixture contract

`fixtures/corpus.json` contains shared `fixture` inputs and an ordered `scenarios` array. A scenario overrides top-level shared fields; `incident` overrides individual incident fields. All other nested values replace their shared value completely. The resulting fixture is hashed before replay.

Each reconstructed fixture contains:

- `id`, `version`, and `incident.provenance`: stable identity and source reference.
- `provider`: the initial simulated world: in-memory JTL and Shopify record store snapshots (`jtl`, `shopify`), the clock (`now`, epoch milliseconds), manual fault rules (`faults`) and an empty provider journal. [provider.mjs](provider.mjs) serves requests against it with the simulator provider packages.
- `incident`: evidence snapshot, proposed action, connection/target grants, external-ID mapping, authority reference, diagnosis revision/status/cause, and initial capability reads. Use `null` for an unknown cause.
- `controls.commands`: ordered `execute`, `approve`, `reject`, `reconcile`, `restart`, `foreign-tenant`, or `advance` commands (`advance` includes `ms`).
- `controls`: optional verification delay, external change before verification, or interruption before execution completion is persisted.
- `expected`: exact ordered capability calls (including input, connection, tenant, version and idempotency key), provider PATCH requests, interpreter outcome sequence, and final JTL shipping method.

Fault rules count provider requests, not capability calls. Reads repeat a transient failure up to three attempts, so a fault meant to fail one read must cover every attempt; a shorter fault is absorbed by the retry, and the scenario no longer exercises the failure it describes.

Expectations are reviewed fixtures, never regenerated from a candidate's output. Unexpected capability calls and provider writes are rejected before dispatch and retained as violations even if execution catches the error. Missing calls, additional calls, wrong ordering, incorrect outcomes and Shopify state changes fail the gate.

The corpus covers successful correction, approval denial, stale evidence, replay/idempotency, tenant isolation, lost response after commit, uncertain dispatch without commit, verification outage after a successful write, delayed/failed verification, exceeded verification windows, and worker restart with a persisted reservation.

### Capture a historical incident

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

### Execution boundary

The harness calls production Playbook, admission, policy/approval, execution, shipping-effect, capability-runtime and JTL/Shopify connector code. Only persistence, identity refresh and incident eligibility data use isolated fixture adapters. Both providers use the existing stateful simulators through an injected transport; no credentials or live endpoints are used.

A restart serializes the complete provider/persistence/ID checkpoint to JSON and constructs fresh services. This tests recovery of durable reservations and read-only reconciliation. Database transactions and Temporal event-history replay remain covered by their integration suites. The checked-in corpus is synthetic; historical cases enter through the capture command.

## Adversarial proposal comparison

The default-off `workflow-red-teaming` release governs model proposal generation. The proposal
function needs a trusted tenant release decision and uses the sensitive EU zero-retention authoring
route. Only trusted catalogue identifiers enter the model. Models select a reviewed fault template,
a bounded mutation and a seed; they cannot supply fixture patches, commands or assertions.

The proposal retains schema, prompt, model, corpus version and hash with every spec. Source-text
variants use seeded malicious strings supplied by the trusted host. Every variant adds a denied
foreign-tenant probe. Baseline and candidate run through the existing shipping-method harness
against the complete mandatory corpus and all materialized proposals; a model cannot omit the
idempotency, isolation, unexpected-write or outcome checks. Reports retain every counterexample,
whether it regresses the baseline, and unsupported scenario classes.

A deployment operator can propose variants for an explicitly selected workspace:

```sh
pnpm propose:red-team <workspace-id> corpus.json .luma/evaluations/proposals.json
```

The command uses the normal server observability configuration to evaluate the workspace's
`workflow-red-teaming` flag through PostHog, defaulting off. Development and test use the existing
feature flag overrides; staging and production reject overrides. Generation requires the approved
EU zero-retention authoring route. The command loads no customer records and grants no execution
authority. Catalogue files are bounded to 1 MiB, and proposals are saved atomically with private
permissions. Keep deployment credentials in server configuration.

Replay a saved proposal after building the normal Playbook evaluator dependencies:

```sh
pnpm evaluate:red-team baseline.json candidate.json corpus.json proposals.json .luma/evaluations/red-team.json
```

The replay command never calls a model and writes its report atomically with private permissions.
Proposals have `schemaVersion: 1`, `corpusVersion`, `corpusHash` and `specs`; each spec has a trusted
`templateId`, `mutation` (`reference`, `source-text`, `identity-probe`) and unsigned 32-bit `seed`.
The model helper also records `promptVersion` and `route`. Mandatory reviewed templates cover
duplicate and stale event bindings, contradictory independent observations, permission revocation
after approval across restart, and unexpected valid provider responses. They run even when the
model selects other variants. Real incident long-tail coverage remains a release prerequisite;
synthetic passes do not establish real incident usefulness.

## Code Step replay

Run `pnpm setup:code`, then `pnpm evaluate:code [corpus.json] [report.json]` to evaluate a pinned Code Step with ordered fixture replies. The default corpus is `fixtures/code-corpus.json`. Every scenario runs twice; outputs, request order and input digests must agree. Reports exclude wall-time and memory measurements. See [Code Steps](../../docs/code-steps.md) for runtime installation, capability grants and deployment limits.

## Authoring evaluation

Configure the EU `authoring` model route, then run `pnpm evaluate:authoring [corpus.json] [report.json]` to describe each workflow in `fixtures/authoring-corpus.json` through the production authoring path. The report (default `.luma/evaluations/authoring.json`) gives the valid-draft rate and the structural equivalence rate against each reference. `pnpm test:evaluation` runs the evaluator against a deterministic fake model. See [Authoring evaluation](../../docs/workflows.md#authoring-evaluation) for the corpus and the equivalence rules.
