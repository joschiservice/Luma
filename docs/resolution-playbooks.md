# Resolution Playbook V0

A playbook applies one reviewed capability action to an eligible incident and
checks its stated outcome. Developers author typed data with `definePlaybook`.
Compilation validates a single serializable IR; the IR supplies execution rules
and version identity. Temporal schedules the existing exception workflow and
activity retries. It does not define the playbook.

## Contract

| Record               | Retained content                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PlaybookDefinition` | Stable ID, name and reusable operational intent                                                                                                                                |
| `PlaybookVersion`    | Semantic version, IR, interpreter/admission compatibility, authorship, source evidence and SHA-256 digest                                                                      |
| `PlaybookActivation` | Tenant, exact version digest, admission artifact digest, principal/connection/target grants and policy version                                                                 |
| `PlaybookRun`        | Incident, diagnosis revision, initiating principal, activation, both version/artifact digests, exact input/evidence snapshot, snapshot digest, concrete action and action hash |
| `PlaybookOutcome`    | Stable step ID, proposal/decision references, finite outcome and reason; execution receipt with dispatch, verification observations and evaluator provenance when available    |

Definitions, versions, activations, run inputs and outcome records are immutable.
Publication accepts source data or a compiled version and verifies any supplied
digest. Publishing the same definition/version with different content fails.
A content change needs a new semantic version; changing operational intent needs a new
stable definition ID. The version digest covers definition, semantic version,
compatibility, provenance and IR using SHA-256 over canonical JSON with sorted
object keys. Array order is significant. Publication does not activate a version.

Activations are explicit and tenant-scoped. Their admission artifacts include the
version digest, grants and policy version in their own digest. The action binding
retains the snapshot’s evidence deadline; admission checks it
again after policy and audit work, immediately before dispatch. Revocation disables
that artifact permanently; a later grant needs a new activation ID. Admission
independently checks grants, current membership, diagnosis eligibility, policy,
approval, idempotency and audit before effects. Playbook code receives no connector
handlers or credentials.

A run's ID is its sole proposed action's UUID. Stable node IDs survive versions
when their meaning stays the same. Changed intent requires a new proposal and run,
not mutation of a previous run or a retry ID for an uncertain write.

## Supported representation

V0 has five visually representable nodes in a fixed linear order:

1. **Eligibility:** conjunction of equality checks over declared scalar evidence
   fields. Missing or mistyped fields fail validation. Evidence must be no more
   than five minutes old, within the playbook's tighter bound, and not future-dated.
2. **Capability:** one capability/version and target kind, with parameters and
   postconditions bound to declared inputs, evidence fields or scalar literals.
   Tenant, connection, resource, requester, expiry and evidence references come
   from the concrete `ProposedAction` and must match the activation and snapshot.
3. **Approval:** `policy` allows the policy engine to decide; `required` requires
   a medium/high minimum risk so independent approval remains mandatory under
   policy `v0.1`. No playbook node supplies approval authority.
4. **Verification:** one initial authoritative verification through the execution
   adapter. The result must use the pinned evaluator version, contain observation
   references, and fall between dispatch preparation and the configured deadline
   (at most five minutes). Provider acceptance alone is insufficient. The window
   limits acceptable observations; connector timeouts and Temporal activity
   deadlines bound I/O. Delayed polling is not part of V0.
5. **Recovery:** reconcile a reserved/uncertain action using reads only, then
   escalate if the bounded result cannot establish the postcondition. Expired
   eligibility cannot trigger another write. The existing Temporal workflow makes
   one reconciliation call, with its bounded activity retry policy; operators may
   request further read-only recovery.

The code view is `export default definePlaybook(<JSON literal>);`. Import
`definePlaybook` from the workflows composition entry point when authoring a
TypeScript module. `printPlaybookCode` and `parsePlaybookCode` round-trip that view
without evaluating code. Unsupported nodes, nesting, parallel branches, executable
expressions and incompatible interpreters fail compilation with an explicit author
review message. They never acquire activation or dispatch authority. V0 has no
Code Step, arbitrary Node.js execution, visual editor, generation or promotion.

## Shipping-method correction

`shippingMethodPlaybook` in the workflows public entry point models the existing
JTL pilot correction. Its input is the mapped `shippingMethodId`. Typed evidence
checks diagnosis readiness and the availability of an approved method mapping.
The capability is `orders.shipping-method.write@0`; an independent approver is
required. Verification uses `shipping-method/1` to reread the order and check its
shipping method. Connector mapping and conditional-write checks still enforce the
exact external order and expected previous method.

The pilot supplies method `8` as input and retains method mapping in trusted
composition. The interpreter contains no merchant-specific identifiers or branches.
Its source provenance is explicitly `pilot`: there is no design-partner case yet.
This outcome proves the correction, not resumed fulfillment. Incident resolution
still uses the existing exceptions verifier. LUMA-25 must select and independently
verify a production business outcome before this becomes a production resolution.

## Composition and persistence

`createResolutionPlaybooks(db, identity, safety)` wires the service to PostgreSQL
and the action-admission service. Trusted composition calls `publish`, `activate`
and `bind`. `bind` checks action bindings and retains the exact typed snapshot;
ineligible snapshots are persisted without dispatch authority. Snapshot loaders
must use tenant-owned immutable evidence and a stable capture time for the diagnosis
revision. Retries must provide the same snapshot. Raw provider documents remain in
their existing evidence stores; playbook snapshots retain the exact selected facts,
observation IDs/times/source versions and capture provenance used for evaluation.

Pass the service, activation ID and snapshot loader as the optional playbook binding
to `createExceptionWorkflowRuntime`. Proposal preparation binds the playbook run;
execution/recovery activities use its stored IR and record outcomes. Temporal
history continues to carry references and finite result codes, not snapshots.
`get` reconstructs the version, run and append-only outcomes after restart.

Migration `0014_resolution_playbooks.sql` creates the five playbook tables owned
by workflows. `luma_desk` has SELECT/INSERT only; forced tenant RLS, composite
foreign keys and indexed identities prevent cross-tenant bindings and preserve
version/run links. Revocation remains in execution's admission store. The existing
workflow runtime login already has `luma_desk` and the safety roles. No new
configuration or database role is needed.

Publication, activation and binding span owner transactions. Replaying them is
idempotent. Run persistence precedes admission binding. A failed snapshot rebind
cannot grant authority. A crash can leave a stored run without an admission binding; retrying
the same inputs completes the binding. Execution requires both records.
The effect reservation and audit path remain in execution, so replay after a lost completion cannot issue
a second write. Outcomes deduplicate identical evidence by content hash and retain
later recovery observations separately. Definitive admission rejections escalate;
transient failures without an execution receipt propagate to Temporal for bounded
retry. A reserved effect remains subject to read-only recovery.

## Validation

Compiler fixtures cover code/IR round-trip, deterministic hashing, unsupported
complexity, types, references, freshness and approval constraints. PostgreSQL
integration fixtures cover the expected call, eligibility, policy denial,
approval, concurrent replay, stale evidence, verification failure, ambiguous-effect
recovery, immutable records, restart and tenant isolation. Pilot E2E exercises the
same playbook through the real Temporal, policy, database and JTL adapter stack.

Run `pnpm check` and `pnpm test:e2e` for the unit, integration and backend
regression suites.
