# Resolution workflows (legacy format)

Resolution workflows, stored as playbooks, apply one reviewed capability action to an
eligible incident and check its stated outcome. They keep their own interpreter and storage
format next to native `workflow/2` versions; the shipping-method correction is the only one
installed. See the [workflow model](workflows.md#compatibility-and-storage) for how both
share one catalog and API.

## Format

A playbook is typed data authored with `definePlaybook`. Compilation validates one
serializable IR that supplies the execution rules and version identity; Temporal only
schedules the exception workflow and its activity retries. The code view,
`export default definePlaybook(<JSON literal>);`, round-trips without evaluating code.

V0 has five nodes in a fixed order. Anything else (extra nodes, nesting, parallel branches,
executable expressions, Code Steps, incompatible interpreter versions) fails compilation
and never acquires activation or dispatch authority.

1. **Eligibility:** equality checks over declared scalar evidence fields. Evidence must be
   no older than the playbook's `maxAgeSeconds` (at most 300) and not future-dated.
2. **Capability:** one capability version and target kind. Parameters and postconditions
   bind to declared inputs, evidence fields or literals. Tenant, connection, resource,
   requester, expiry and evidence references come from the concrete proposed action and
   must match the activation and snapshot.
3. **Approval:** `policy` lets the policy engine decide. `required` needs a medium or high
   minimum risk, which policy always routes to an independent approver. No node supplies
   approval authority.
4. **Verification:** one authoritative read through the execution adapter with the pinned
   evaluator version, observation references, and observations between dispatch
   preparation and a deadline of at most five minutes. Provider acceptance is not enough.
5. **Recovery:** reconcile a reserved or uncertain action with reads only, then escalate if
   the postcondition cannot be established. Expired eligibility never triggers another
   write.

## Identity and immutability

Definitions, versions, activations, run inputs and outcomes are immutable. Publishing the
same definition and version with different content fails: a content change needs a new
semantic version, and a change of operational intent needs a new definition ID. The digest
is SHA-256 over canonical JSON with sorted object keys; array order is significant.
Publication is a trusted composition operation, not a browser command, and never activates.

A run's ID is its single proposed action's UUID. Changed intent requires a new proposal and
run, never a mutated run or a new retry ID for an uncertain write.

## Activation and admission

Activation is explicit and tenant-scoped. Its admission artifact digest covers the version
digest, principal, connection, target grants and policy version. It requires
`playbooks.activate`, an exact reviewed digest, a connection granting the capability's
reads and writes, and explicitly selected targets. Retry an uncertain request with the same
ID and body. Overlapping active grants for the same principal, connection and targets are
rejected; revoke first. A newer version needs another review.

Revocation blocks future admission under that artifact permanently; reactivation needs a
new activation ID. It keeps history and does not undo or cancel dispatched work. Admission
independently checks grants, membership, diagnosis eligibility, policy, approval,
idempotency and the evidence deadline (again, right before dispatch). Playbook code
receives no connector handlers or credentials. The API needs the `luma_desk` and
`luma_connectors` roles; execution writes stay with the worker.

## Persistence and recovery

- Snapshot loaders must read tenant-owned immutable evidence with a stable capture time
  for the diagnosis revision, and retries must supply the same snapshot. Snapshots keep
  the selected facts and observation provenance; raw provider documents stay in their own
  evidence stores, and Temporal history carries only references and result codes.
- The run persists before its admission binding. A crash in between leaves a run without
  a binding; retrying the same inputs completes it, and execution requires both. An
  ineligible snapshot is persisted without dispatch authority.
- Effect reservation stays in execution, so replay after a lost completion cannot write
  twice. Outcomes deduplicate identical evidence by content hash and keep later recovery
  observations separately.
- Definitive admission rejections escalate. Transient failures without an execution
  receipt propagate to Temporal for bounded retry. A reserved effect stays subject to
  read-only recovery.

## Shipping-method correction

The correction writes the mapped shipping method on a JTL order through
`orders.shipping-method.write` with an independent approver, and verifies by rereading the
order. Merchant method IDs are inputs; the interpreter has no merchant-specific branches.
Connector mapping and conditional writes still enforce the exact external order and
expected previous method.

A verified correction proves the method changed, not that fulfillment resumed. Incident
resolution still uses the exception verifier. Runs keep their provenance: pilot runs are
labeled, and runs without source classification are never counted as live verified
success.
