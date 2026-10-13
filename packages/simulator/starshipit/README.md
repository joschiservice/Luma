# Starshipit simulator

This account implements the orders and tracking API subset used by Luma's installed
Starshipit adapter. Provider records are independent of Shopify and the ERP. Only the
simulator engine knows which shop order the warehouse imported; a matching order number
or SKU never links canonical records in Luma.

The protocol follows the [Starshipit API documentation](https://api-docs.starshipit.com/):
orders are paged separately for Unshipped, Printed and Shipped; details and tracking use
the documented envelopes. Full item updates apply only before labels are printed.
Writes have no simulated provider idempotency guarantee. The host can commit a write,
then lose its response, so Luma must reconcile through a fresh read.

Parcel item allocations are internal ground truth. Starshipit's documented tracking
response does not establish which order lines a split parcel contains; the adapter
therefore leaves shipment lines unknown even when the simulator knows the allocation.
A Printed parcel does not prove that a carrier collected it. Advancing time does not
refresh a stored carrier timestamp. The merchant can explicitly record a scan with an
old timestamp to reproduce stale tracking.

The host applies transport faults, duplicate delivery and delayed delivery to webhook
notifications. The `webhook` merchant command queues copies with an old provider
update time without changing authoritative state. A callback is only a wakeup for a
fresh provider read. Starshipit's public documentation does not establish a signing
protocol; the local callback uses the explicitly configured destination bearer secret
supported by Luma, rather than pretending Starshipit signs it. Reordering is a chaos
transport assumption, not a guarantee about Starshipit delivery order.
