# Shopify fulfillment recovery

The Shopify record panel offers hold release, reopening and moving all remaining
items. Each preview binds an exact connection, source order, fulfillment order,
revision and selected hold or destination. Shopify's supported actions, complete
line reads and eligible move locations determine availability. Reauthorization
requests fulfillment write scopes; existing read-only connections remain usable.

The app composition in `packages/apps/shopify/src/fulfillment-recovery.ts` uses
the shared policy, execution, audit and Action Admission services. The requester
and approver must be different people; both need `shopify:fulfillment_recovery.run`, and the approver also `decisions.respond`. A preview stays open for a
four-hour decision window. Shopify is read again before dispatch, and membership,
installation, grants, source revision and eligibility are checked on that read. Only references to persisted previews enter
the execution endpoint.

Migration `0042_shopify_fulfillment_recovery.sql` stores immutable previews,
allowlisted observations and acceptance receipts under forced tenant RLS. A
transactional claim serializes recovery for each fulfillment order and prevents
multiple actions against one revision. A durable acceptance or confirmed withheld
write releases the target lock; the revision claim remains. Uncertain attempts
retain the lock. Reloads and retries use the original proposal and never resend
a reserved mutation. Reconciliation only reads Shopify.

Shopify does not expose a compare-and-swap revision argument on these mutations.
Luma rechecks immediately before dispatch; Shopify remains the final authority
on eligibility. Hold releases always supply a single `holdIds` entry. Moves
omit a line subset and therefore move all remaining items. A move destination
must support every remaining line; truncated reads and approximate unavailable
line counts cannot authorize the move.

Mutation acceptance is separate from business progress. Verification requires a
fresh complete read of the same fulfillment order, unchanged line identities and
totals, and fewer remaining units. Changed identities after a move, cancellations,
partial reads and unchanged quantities remain unverified. The operator gets an
explicit recovery decision and can inspect Shopify or check again. Luma does not
close an operational issue from a mutation receipt.

[Needs you](needs-you.md) lists recoveries awaiting approval, approved recoveries waiting for
their requester, and accepted or uncertain recoveries without verified progress, through the
same `fulfillment` slot.

Validation: `pnpm test:e2e shopify-fulfillment.e2e.mjs`, the Shopify provider unit
tests, and `Orders/Shopify fulfillment recovery` stories. Refresh and validate the
pinned GraphQL schema with `node apps/api/scripts/update-shopify-schema.mjs 2026-07`.
