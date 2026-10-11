# ADR-012: Native order records and source evidence

Status: Accepted. Date: 2026-10-11.

## Context

Canonical orders retain evidence from each connected system. Their immutable snapshots
are unsuitable for editable business records, particularly addresses and customer references.
Luma needs to own orders while keeping the same comparison, authority and verification rules.

## Decision

`@luma/sales` owns editable, relational order and line records. `@luma/orders` continues to
own immutable canonical evidence. Sales exposes committed business facts through a built-in
Luma ERP connection with the ERP category and the ordinary order-read capability.

Intake accepts a current Shopify source into one record and binds the internal order and
lines to the existing canonical identities. Display numbers never establish that identity.
The source must report a known number, currency, lifecycle and current line quantities.
Unknown prices and tax remain unknown. Intake does not select authority.

The shared runtime composes Sales, Connections, Orders and Audit with a transaction-scoped
database. Record writes, observations, mappings, canonical snapshots, list refreshes and audit
receipts commit together. A failure rolls back the entire change. Owner adapters never open a
second transaction or copy another owner's SQL write implementation.

Publication contains only order evidence. Addresses and customer references stay in the
record store and retry receipts; they never enter immutable observations or audit details.
An address edit or unchanged record does not publish another snapshot. Quantity edits clear
an imported total because shipping, discounts and tax adjustments cannot be inferred from
line prices. Cancellation publishes zero current units while preserving original quantities.

Luma ERP is eligible for explicit, audited source-authority overrides. It is excluded from
automatic defaults, so accepting an order cannot silently change operational authority.
Edits require Luma ERP authority for both lifecycle and lines, current Sales and import
permissions, and the reviewed record version. Identical command retries return the committed
result; changed command content is rejected. Cancelled orders cannot reopen.

The server evaluates the workspace release flag with a false fallback. The API reports its
effect to the browser. Release state does not grant permissions or select authority. No
workflow evaluates the flag during replay.

Business records have a different retention obligation from evidence. Records and their
personal fields are retained separately from evidence and audit, which retain nonpersonal
provenance. Erasure must remove personal fields from both records and retry receipts; changing
an address alone does not erase earlier command results. Turning off the release does not delete records.
Evidence thinning, invoicing and channel synchronization require separate decisions.

## Alternatives and consequences

Editing canonical snapshots would mix business authority with retained evidence and retain
personal data indefinitely. A separate ERP application would duplicate the canonical read and
operational surfaces. Publishing asynchronously would expose a committed record without its
current evidence and require every consumer to account for lag.

Same-transaction publication costs more than saving the record alone and requires the API's
restricted runtime to hold the evidence owners' roles through `luma_sales`. It avoids a new
outbox and preserves atomic list updates. The flag controls release; domain permissions and
source-authority configuration control who may edit and which facts Luma owns.

Reversing this choice requires exporting Sales records and preserving their source mappings
and provenance. Removing the release does not undo recorded authority or evidence.
