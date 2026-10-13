# Supplier commitments

Procurement follows a Luma purchase order after it is drafted: an approval-controlled
submission to the supplier's purchasing system, the supplier's confirmation, and booked
goods receipt. Each milestone needs its own evidence. A purchasing-system order gets receipt
from that system; an open Luma order without a purchasing system may have a manual receipt. The first channel is JTL-Wawi purchase orders; see
[Procurement records](procurement.md) for the order lifecycle and
[JTL](jtl.md#purchase-orders) for the provider behavior.

## Evidence model

| Milestone          | Evidence                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| Drafted            | The Luma order; replenishment drafts add the run's independent verification                                    |
| Sent to supplier   | An independent read finds the purchasing-system order, or the inbox verifies the approved outgoing order email |
| Supplier confirmed | Confirmed quantities and dates, read from the purchasing system or recorded from a message                     |
| Goods received     | Delivered quantities read from the purchasing system, or an explicit manual receipt for orders without one     |

Commitments are append-only facts (confirmed quantity, promised date, shipped, condition,
received), each with its source: a purchasing-system observation, a supplier message span,
or a correction with a reason. A database check requires purchasing-system or explicit manual-receipt evidence,
and a trigger rejects manual receipt for purchasing-system orders. Only a pending review may
change a commitment. Corrections add a commitment
that supersedes the earlier one; values are never edited.

Line progress, milestones, the expected date, attention items and the next owner are
derived from persisted records and the current time by one function shared by lists,
records and Needs you. Lists derive it per request, so volumes beyond a few thousand orders
per tenant need a maintained progress projection.

## Submission

A submission needs a Luma-owned draft or open order, a supplier linked to an active
connection granted `purchase-orders.submit` and `purchase-orders.read`, and every line SKU
mapped to an item on that connection. Luma stores the submission and asks Action Admission
to bind the exact high-risk `purchase-orders.submit` action. Policy then requires approval under the [workspace rules](workspace-settings.md#approval-preference), with `decisions.respond` and the purchasing capability's permission, such as
`jtl:purchase_orders.submit`. Requests expire after 24 hours.

Approval dispatches immediately as the requester through a resolved workflow context; the
approver gains no execution authority. The background pass also dispatches approved
submissions. Execution reserves `v0:<action ID>` before dispatch; the JTL adapter derives
its `Idempotency-Key` from it and refuses to post while an order with the same marker
exists. Adapter acceptance is not the outcome: verification reads JTL independently. An
uncertain dispatch stays `uncertain` and only ever reconciles by reading. A verified draft
moves to open with an audited reason.

Live JTL installations are not granted `purchase-orders.submit` until a sandbox smoke test
confirms the write; simulated installations are.

## Confirmations and receipts

A background pass (every 15 seconds in the commerce sync worker; the pilot runs the same
pass) reads placed orders by their JTL ID, stores an observation when content changes, and
inserts commitments keyed by submission, line, kind and value. Repeated reads and duplicate
values never add a second commitment. A submission settles when every line is received or
the Luma order is closed or cancelled.

## Email submission and follow-ups

A Luma-owned order whose supplier has no purchasing-system link may be submitted through a
connected Operations Inbox. Procurement drafts an English or German PDF from the immutable
order and explicit company details, then leaves review, approval and sending to the inbox.
The inbox's independent acceptance read records an email submission and opens the draft.
It never creates a confirmed quantity or supplier commitment. A permanent bounce becomes a
failed submission in Needs you; the original acceptance time and outgoing message stay as
evidence. Uncertain sends are reconciled only by reading.

Overdue confirmation and delivery items offer an inbox follow-up draft showing what was
promised and what remains outstanding. Its verified send records the outgoing message and
next check time. Concurrent deadline decisions are not overwritten. Supplier replies return
through the same linked thread and message extraction path. Without an inbox, manual
follow-up remains available. Both email entry points default off behind tenant-scoped
PostHog releases; turning one off prevents pending dispatch, while reads keep prior evidence.

## Supplier messages

Messages are stored once per message ID, or per digest of sender, subject, time and text.
With an EU zero-retention Bedrock route for the `supplier-extraction` profile
([model gateway](model-gateway.md#supplier-extraction-profile)), the model lists statements
with exact quotes. Facts whose quote is not in the message are dropped. Material changes,
conditions, unmatched lines and low-confidence facts wait for review; matching facts count
immediately. Without a route, people select words in the message to record facts and no
model is called.

Message text is removed after `supplierMessageRetentionDays` (365 by default) or on
request. Spans keep their offsets and the content digest remains; quotes show only while
the text exists.

## Attention and follow-ups

Attention covers approvals, uncertain sends, facts to review, changed commitments, missed
confirmations (submission time plus the supplier's confirmation hours) and overdue
deliveries (expected date passed with units outstanding). People decide on missing or damaged goods, accept a change or record
a follow-up with the next check time; the follow-up moves the deadline and the item returns
when it passes. Needs you shows these items under the purchase order, whose review uses the
order's own controls.

## Receipt reconciliation

Manual receipts are cumulative per line. Receipt and damaged quantities are persisted in the
same transaction. Good received quantity excludes damage; it does not itself prove available
stock changed. Missing and damaged units remain attention items until a person records a
decision, a reason and evidence. Waiting postpones attention only until its check time.
Credited or written-off shortages reduce the remaining expected arrival without altering
the receipt observation. Earlier facts stay in history, and corrections name the current
fact they supersede. Exact command retries return the original result; a stale correction or
a competing decision fails and requires review.

## Submitted order revisions

An order revision freezes the current local order and a complete, current source read.
Approval binds one position operation and its reason. Received positions cannot be changed,
the final position cannot be removed, and only one active revision may exist per order.
Quantity changes that affect supplier commitments remain visible in review. Existing
commitments retain the order revision against which they were recorded.

JTL permits quantity/date updates, addition and removal of positions while the source order
is Open or Released. These writes have no provider idempotency guarantee. An execution
attempt is recorded before dispatch and sent once; after uncertainty or process restart,
Luma reconciles through an independent read. It appends the previous and new local revisions
only after the full requested source shape is verified. An incomplete or stale read does not
advance the local revision. Local lifecycle transitions cannot run while a revision awaits
approval or verification.

JTL-Wawi 2.2 does not expose purchase-order cancellation. Marking a source order Completed
is not cancellation and is never used as a substitute. Native submitted orders therefore
have no cancellation action; arrange cancellation in the purchasing system and reconcile
its evidence before replacing an order. Live revision grants remain withheld until the
installation's endpoint behavior has been verified; simulator installations exercise the
same admitted operation and independent verification path.

The purchasing timeline combines saved plans and approvals, submission, supplier messages,
append-only commitment and receipt facts, buyer follow-ups, revisions and stock booking proof.
A recorded manual receipt, an email sent and a supplier observation retain separate labels;
only independent verification establishes the action's result. Stock proof is visible only
to readers with inventory access. The history is tenant-scoped and shows at most the latest
500 events, with truncation reported rather than treated as complete evidence.
