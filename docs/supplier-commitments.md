# Supplier commitments

Procurement follows a Luma purchase order after it is drafted: an approval-controlled
submission to the supplier's purchasing system, the supplier's confirmation, and booked goods
receipt. The first channel is JTL-Wawi purchase orders (ERP API 2.2). See
[Procurement records](procurement.md) for suppliers, orders and their Luma lifecycle, and
[JTL](jtl.md#purchase-orders) for the provider behavior.

## Evidence model

Four milestones stay separate and each names its evidence:

| Milestone          | Evidence                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Drafted            | The Luma order; replenishment drafts add the run's independent verification                  |
| Sent to supplier   | An independent read finds exactly one purchasing-system order with the Luma marker and lines |
| Supplier confirmed | Confirmed quantities and dates, read from the purchasing system or recorded from a message   |
| Goods received     | Delivered quantities read from the purchasing system; nothing else establishes receipt       |

Commitments (`domain/commitments.ts`) are append-only facts: confirmed quantity, promised
date, shipped, condition and received. Each carries its source: a purchasing-system
observation, a supplier message span, or a correction with a reason. A database check rejects
`received` from any other source, and a trigger allows only a pending review to be answered.
Corrections add a commitment that `supersedes` the earlier one. Values are never edited.

`orderProgress` derives line progress, milestones, the expected date, attention items and the
next owner from persisted records and the current time. Lists, records and Needs you share it.

## Submission

`SupplierCommitments.requestSubmission` checks readiness: a Luma-owned draft or open order, a
supplier linked to an active connection granted `purchase-orders.submit` and
`purchase-orders.read`, and every line SKU mapped to an item on that connection. It stores a
submission and asks Action Admission to bind the exact `purchase-orders.submit` action
(capability version `0`, target `purchase_order_submission`, high risk). Workspace policy then
requires a different owner or admin. Requests expire after 24 hours.

Approval dispatches immediately as the requester, through a resolved workflow context; the
approver gains no execution authority. The background follow-up also dispatches approved
submissions. Execution reserves `v0:<action ID>` before dispatch, and the JTL adapter derives
its `Idempotency-Key` from it and refuses to post while an order with the same marker exists.
The adapter's acceptance is not the outcome: verification reads JTL independently. An
uncertain dispatch stays `uncertain` and only ever reconciles by reading. A verified draft
moves to open with an audited reason.

## Reading confirmations and receipts

Each pass reads placed orders by their JTL ID, stores an observation when the content changes,
and inserts commitments keyed by submission, line, kind and value. Repeated reads and
duplicate values never add a second commitment. A submission settles when every line is
received or the Luma order is closed or cancelled.

## Supplier messages and extraction

`recordMessage` stores a message once per message ID, or per digest of sender, subject, time
and text. When the `supplier-extraction` model profile has an EU zero-retention Bedrock route
(`supplierExtractionAvailability`), the model lists statements with exact quotes. Facts whose
quote is not in the message are dropped. Material changes, conditions, unmatched lines and
low-confidence facts wait for review; matching facts count immediately. Without a route,
people select words in the message to record facts. The same data policy as
[workflow authoring](model-gateway.md) applies.

Message text is removed after `supplierMessageRetentionDays` (365 by default) by
`purge_expired_procurement_communications`, or on request. Spans keep their offsets and the
content digest remains; quotes are shown only while the text exists.

## Attention and follow-ups

Attention items cover approvals, uncertain sends, facts to review, changed commitments,
missed confirmations (submission time plus the supplier's `confirmationHours`) and overdue
deliveries (expected date passed with units outstanding). People accept a change or record a
follow-up with the next check time; a follow-up moves the deadline, and the item returns when
it passes. `supplierCommitmentDecisionProvider` presents them in Needs you with owner
`purchase_order`, whose review mounts the order's own controls.

## Runtime and storage

- Migration `0049_supplier_commitments.sql`: submissions, communications, extractions,
  commitments, observations and follow-up responses, all with forced tenant RLS for
  `luma_desk`, and the scope and retention functions.
- API: `createApplicationServices` takes `purchasing` (an installed purchase-order runtime and
  connection list). Sending requires enabled execution.
- Background: the commerce sync worker runs `createSupplierFollowUpWorker` every 15 seconds.
  The pilot worker runs the same pass every 10 seconds.
- Read models: `createProcurementContext` reads stock, products, issues and the replenishment
  trace for an order or supplier.

## Validation

- `pnpm --filter @luma/procurement test` for progress rules and extraction quoting.
- `pnpm test:e2e supplier-commitments.e2e.mjs` covers linking, approval by a second admin,
  one placement, a partial confirmation, change acceptance, duplicate messages and receipt.
- `pnpm test:browser supplier-commitments.browser.mjs` covers a lost submission response,
  approval from Needs you, recording a commitment from selected message text, receipt,
  narrow screens and the dark theme.

Live JTL installations do not receive `purchase-orders.submit` until a sandbox smoke test
confirms the write grant; simulated installations do. Volumes beyond a few thousand orders
per tenant need a maintained progress projection, because lists derive progress per request.
