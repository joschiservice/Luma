# ADR-015: Shared Shopify request admission

Status: accepted

## Context

Shopify charges API requests against an app/shop cost bucket. Separate API clients and
worker processes must coordinate that budget so background imports leave capacity for
live investigation and governed action reads. Requested cost, actual cost refunds,
provider cooldowns and outstanding requests all affect admission. Durable job ownership
and external-effect safety already belong to PostgreSQL and Temporal.

## Options considered

- PostgreSQL row locks can coordinate admission, but couple frequent transport bookkeeping
  and provider cooldowns to the database serving canonical records and execution claims.
- Generic distributed rate limiters model fixed windows or token buckets. Shopify also
  needs per-request requested/actual cost reconciliation and priority across independently
  composed clients. A local priority queue cannot enforce that policy across processes.
- Durable queues and workflow engines are useful for retryable background work. They
  cannot serve every synchronous provider request without adding another dispatch hop and
  still require a shared model of Shopify's cost bucket.
- Valkey provides atomic scripts and expiring state independently of the durable store.
  The official GLIDE client supports standalone and clustered primaries through the same
  infrastructure port.

## Decision

Use region-local Valkey with GLIDE for shared Shopify transport admission. Keep one
opaque key per trusted tenant, app identity and shop, with bounded query-shape knowledge
and expiring reservations. A single atomic script admits work, reconciles cost feedback,
shares cooldowns and protects foreground headroom. Foreground waits are bounded;
background work defers to its existing durable checkpoint.

Transport admission carries no action authority. Execution rechecks its controls after
admission and credential refresh, immediately before a mutation is sent. Mutations retain
their existing dispatch fences and retry rules. Independent reads still establish
verification. Accepted provider responses survive failed admission bookkeeping.

## Consequences

API and worker deployments require an authenticated, region-local primary with
persistence, no eviction and permission to read the server epoch. An unavailable
coordinator defers provider requests; it does not trigger local fallback. Restart invalidates
old permits and relearns cost conservatively. Cancellation refunds only an unused permit;
lease expiry never proves that a provider request consumed no cost.

Concurrent responses have no provider ordering token. Admission constrains refunds
against outstanding reservations and the lowest recent provider balance; provider restore
replenishes both limits. An isolated request sent after prior feedback can correct drift
from its fresh provider observation. Valkey replication is asynchronous: a failover can lose recent
admission state. Shopify remains the final quota authority. Authorization, approval,
execution claims, idempotency, audits and resumable sync state remain in PostgreSQL and
Temporal, where that loss cannot authorize or duplicate an external effect.
