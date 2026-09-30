# Needs you decision queue

Needs you lists every decision that waits on a person, whichever owner raised it. It is a
read projection: each item points to the owner's authoritative decision, and responses go
through that owner's review. The queue never approves, rejects or runs anything.

## Sources

| Source                           | Owner and rule                                                                                                                                                                                                                 | Responses                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Cases (`case:<exceptionId>`)     | `caseDecisionQuery` in `@luma/exceptions`: the inbox attention rules (approval, manual step, uncertainty), minus approvals whose current proposal already has a response                                                       | Case desk review and decisions                                          |
| Replenishment (`replenishment:`) | `pending` on the procurement replenishment service: runs awaiting a decision whose proposal is bound, unexpired and unanswered, with the same `canRespond` rule as the run review                                              | `decideReplenishment` on the workflow run                               |
| Apps (`<appId>:<kind>:<id>`)     | `AppDefinition.decisions` in `@luma/app-host`. Shopify lists stock corrections and fulfillment recoveries awaiting approval, awaiting a run by their requester, or accepted/uncertain without a verified outcome (last 7 days) | The app's own commands through its `inventory` or `fulfillment` UI slot |

Owners present their decisions: `why`, `consequences` (what each response causes), `change`
(the exact source, record, location and quantities) and evidence validity. Case and
replenishment wording lives in `packages/read-models/src/domain/decisions.ts`; app wording
lives in the app (`packages/apps/shopify/src/application/decisions.ts`).

Providers read persisted state only. They must not call providers or models. A Shopify preview
can therefore be listed as approvable and still be refused when its review reads Shopify and
finds a changed revision. Members get no app decisions because the Shopify services require an
owner or admin.

## Ranking and paging

`createDecisionQueue` (`packages/read-models/src/infrastructure/decisions/queue.ts`) asks each
provider for the refreshed reader, then runs one repeatable-read query that unions the case
rows with the provider rows (passed as a JSON parameter), joins assignments and resolves
source record identities through tenant mappings.

Rank 0 is a deadline within 30 minutes, rank 1 is high impact, rank 2 is the rest. Unknown
impact is labeled, not ranked below low. Items then sort by deadline, request time and ID.
Keyset cursors bind the tenant, reader, view, filters and page size, and carry the first
page's evaluation time so expiring items do not move between pages. Provider rows are
recomputed per request; clients refresh from the first page and deduplicate by ID.

A provider that throws is reported in `sources` as `unavailable`. Its decisions are missing,
not resolved, and the rest of the queue still loads.

## Assignment

`decision_assignments` (migration `0047_decision_queue.sql`) stores the current owner per
decision ID with an optimistic revision. Resolution owns the writes
(`packages/resolution/src/application/decision-assignments.ts`). Any member may take an
unassigned decision or release their own; owners and admins may assign any decision to a
current member. The decision must currently be in the reader's queue. Assignment never grants
approval authority.

## Live refresh

Migration 0047 adds `luma_metrics` notification triggers to assignments, workflow process
steps, replenishment claims, executed actions and the Shopify preview and claim tables. Case,
proposal and policy tables already notify. The web queue subscribes to the shared workspace
metric stream and refetches on every `refetch` event, and polls every 30 seconds while the
stream is interrupted.

## Web

The page is `apps/web/src/features/decisions` (`page.tsx`, `inspector.tsx`,
`owner-review.tsx`, `data.ts`, `live.ts`, `presentation.ts`). The route is
`/app/:organizationId/needs-you` with `view`, `domain`, `reason`, `cursor`, `item` and `grouped`
search parameters. The inspector mounts the owner's controls: `CaseResolution`,
`ReplenishmentRunReview`, or the app's `inventory`/`fulfillment` slot. An opened item that
leaves the queue stays visible, labeled as departed, so the outcome remains readable. Home's
attention module and the sidebar count read the same API.

## Adding a source

1. Keep the decision and its checks in the owner. Add a read that returns only decisions that
   need a person now, from persisted state, bounded in size.
2. Present each decision with a stable, prefixed ID, the reason, why, consequences, exact
   change, deadline and evidence validity. Say `unknown` for impact without an explicit rule.
3. Give it a `DecisionOwner` the web can mount, and add a case in `owner-review.tsx` if needed.
4. Add its tables to the metric notification triggers.
5. Cover the reader-specific `response`, removal after a response on another surface, and
   tenant isolation in `apps/api/e2e/decisions.e2e.mjs` or the owner's e2e suite.

## Validation

`packages/read-models/src/domain/decisions.test.ts`, the web `decisions` unit tests and
`Needs you/Queue` stories; `pnpm test:e2e decisions.e2e.mjs shopify-inventory.e2e.mjs`;
`pnpm test:browser decisions.browser.mjs`.
