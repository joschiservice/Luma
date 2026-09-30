# Replenishment workflow

`inventory-replenishment@1.0.0` replenishes a mapped inventory position through
an ordinary `workflow/2` process. It needs no Exception. Operators configure and
review it in Workflows, inspect its evidence in Recent runs and Activity, and
open the resulting draft in Procurement.

## Rule and authority

An owner or admin activates one exact position, source connection and supplier.
The immutable rule records minimum stock, target stock, a quantity risk threshold,
principal, workflow digest and admission artifact. Only one active rule may cover
a position. Revoke it before changing the scope. The worker uses the activating
principal and refreshes membership at each activity and admission check.

When available stock is below the minimum, quantity is
`ceil(target - available)`, capped at one million units. Current canonical
inventory must be complete enough to provide a numeric available quantity and
must be less than five minutes old. Deleted, missing, future and stale stock
cannot authorize an order. Draft and open orders for the same SKU stop
replenishment, across suppliers and inventory sources.

The risk threshold makes larger proposals high risk. Smaller drafts retain the
Procurement capability's medium-risk floor. Current workspace policy requires a
different owner or admin to approve both. This workflow never reduces the
capability's risk or treats a workflow decision as execution authority.

Action Admission binds the proposal to the run, action step, subject and exact
artifact. Procurement uses a subject reference instead of an incident ID. Before
dispatch, eligibility rechecks the active scope, current inventory, quantity,
unit, supplier and existing orders. Evidence expires five minutes after the
trigger's source observation; approval does not extend that deadline.

## Durability and outcomes

The worker uses the existing Temporal process interpreter on the
`<taskQueue>-procurement` queue. API starts persist before Temporal dispatch.
The monitor checks active scopes every five seconds, uses an observation-based
source ID for deduplication and recovers committed unfinished starts. Manual
stock checks use a client request ID; exact retries recover the same run.

Stable proposal, order and line UUIDs derive from the run. Tenant/position and tenant/SKU claims
serialize overlapping workflow proposals. The Procurement owner checks for
existing commitments again inside the order-creation transaction. Terminal runs release the claim;
existing drafts continue to prevent another replenishment. A worker restart
preserves decisions, action receipts and step evidence.

A successful capability receipt is not the business outcome. An independent
read checks Luma ownership, draft status, revision, supplier, immutable lines,
origin and command audit. Failed or unavailable verification remains visible;
it cannot become verified success. The outcome is a **purchase-order draft**,
not a supplier submission or receipt of goods.

Migration `0028_replenishment.sql` adds tenant-isolated rules and claims. Worker
scope discovery exposes routing identities only. Application, approval and
inventory reads still enforce tenant and membership checks. Activity joins
native run bindings without inventing an Exception.

## Validation and simulator scenarios

`pnpm simulator:replenishment` runs the repeatable Procurement V0 scenario matrix
against the existing provider simulator, isolated PostgreSQL and a real local
Temporal server. It covers:

- Happy path with a different human approver and verified draft.
- Policy rejection with no purchase-order write.
- Stale inventory after triggering, plus rejection of a stale start.
- Existing draft and open purchase orders.
- Retried starts and activation responses, with a worker restart during approval.
- A concurrent purchase-order cancellation causing independent verification failure.

The stale and verification scenarios deliberately change test-owned evidence or
records at activity boundaries. They use the normal interpreter, policy,
admission and Procurement services; they do not supply a fake success result.
Browser coverage is `pnpm test:browser replenishment.browser.mjs` and includes
activation response loss, separate requester/approver sessions and a narrow
viewport. Unit coverage is colocated with the quantity rule and process compiler.

For interactive local use, start the simulator stack, let it collect mapped
inventory, add a supplier in Procurement, and open **Workflows → Replenish low
stock → Stock rules**. Activate a rule with a minimum above current stock, then
use **Check stock now** or let the worker detect the condition. Sign in as the
other workspace admin to approve the exact proposal in Recent runs or in
[Needs you](needs-you.md), which lists the same decision until it expires.
