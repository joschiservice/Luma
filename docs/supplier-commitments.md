# Supplier commitments

Procurement follows a Luma purchase order after it is drafted: an approval-controlled
submission to the supplier's purchasing system, the supplier's confirmation, and booked
goods receipt. Each milestone needs its own evidence, and only the purchasing system
establishes receipt. The first channel is JTL-Wawi purchase orders; see
[Procurement records](procurement.md) for the order lifecycle and
[JTL](jtl.md#purchase-orders) for the provider behavior.

## Evidence model

| Milestone          | Evidence                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Drafted            | The Luma order; replenishment drafts add the run's independent verification                  |
| Sent to supplier   | An independent read finds exactly one purchasing-system order with the Luma marker and lines |
| Supplier confirmed | Confirmed quantities and dates, read from the purchasing system or recorded from a message   |
| Goods received     | Delivered quantities read from the purchasing system; nothing else establishes receipt       |

Commitments are append-only facts (confirmed quantity, promised date, shipped, condition,
received), each with its source: a purchasing-system observation, a supplier message span,
or a correction with a reason. A database check rejects `received` from any other source,
and a trigger allows only a pending review to be answered. Corrections add a commitment
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
deliveries (expected date passed with units outstanding). People accept a change or record
a follow-up with the next check time; the follow-up moves the deadline and the item returns
when it passes. Needs you shows these items under the purchase order, whose review uses the
order's own controls.
