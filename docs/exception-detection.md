# Exception detection

Detection evaluates the five [V0 taxonomy](exception-taxonomy.md) classes against
normalized evidence and persists the result as tenant-scoped incidents. It records every
accepted evaluation with its rule and configuration versions, decision, evidence
references and delivery correlation ID (inventory also keeps the exact signed difference,
left minus right). Detection opens, updates and verifies incidents; it never repairs,
redispatches or records a verified resolution without independent verification. `@luma/exceptions` owns the
rules and persistence; `@luma/application-runtime` composes them.

## Ingestion

Every entry point requires an identity-resolved `TenantContext` (workers resolve current
membership first); there is no unauthenticated ingestion route. Callers must:

- Pass explicit mappings. Equal labels never establish identity, external IDs include
  their parent scope, and JTL aggregate stock needs an explicit equivalent Shopify pool.
- Resolve fulfillment holds and schedules from trusted evidence, passing `unknown` when
  unavailable. Keep split operations separate and never sum mirrored shipments.
- Supply `firstFailureAt` for scans and reset it only after a complete success. A single
  successful page never sets `scanComplete`.
- Give unknown workflow effects an execution reference for reconciliation. The workflow
  path has no connector write port.
- Keep observation and event keys stable on redelivery and use a new key for each new
  authoritative poll. Keys identify immutable evidence within a tenant; namespace provider
  event IDs by connection.
- Store only normalized facts and provenance, never credentials, error text or customer
  payloads. Raw payload retention stays with the connector.
- Pass a new configuration version whenever a threshold changes; reusing a version with
  different values fails atomically. The persisted version is the one the evaluation used.

The delivery correlation key does not identify evidence; changing it adds no occurrence.
Inject the clock for reproducible replay.

## Scheduled detection

The commerce sync process runs the detection worker once a minute. For each active
workspace with an active sync it acts as the person the sync runs as; suspended and closed
workspaces are skipped without a failure. Stored state selects candidates; fresh provider
reads decide:

- **Sync failure:** every orders, fulfillment, product and stock stream with failed pages
  is evaluated with its first failure time, latest error code and whether five attempts
  failed. The evidence key changes only with a new failure, so repeated passes add no
  occurrences.
- **Stock mismatch:** positions reported by at least two connections, because people
  linked their SKU and location, are compared when stored availability differs. Each ERP
  report is paired with each storefront report; the app category decides the roles and
  the ERP is the authority. Both sides are reread and projected before the rule runs, at
  most 25 positions per pass. Before the reread, the monitor reads the stored reports of
  the last 24 hours to find when the pair last agreed, so the rule can let a fresh gap wait
  for provider sync.
- **Stuck fulfillment:** open work without progress for the stuck threshold is reread
  through its order, at most 25 per pass, oldest progress first. A future start time
  exempts the work. A reported hold exempts it until the work has gone 24 hours
  (`holdOverdueSeconds`) without progress; then the hold is why it is stuck and the
  eligibility evidence records `holdOverdue`. Work from an adapter that does not read
  holds stays `unknown`.

- **Order quantity:** orders whose maintained source comparison shows a current-units
  difference that changed at least the propagation window ago are checked, at most 25 per
  pass, least recently read first. Every source read before the window ended is reread
  first: the order through the `orders.read` point read and its fulfilment records through
  an order-scoped `fulfillment.read` (see [Orders refresh](orders-workspace.md#refreshing-an-orders-sources)).
  The rule then runs on each line of the refreshed comparison, with order-line authority.

Open cases of these classes are always included. When the fresh evaluation is clear, the
monitor requests verification: stock and fulfillment reread the case's exact subject; a
sync failure passes once its stream completes a scan after the latest detection without
new failures; an order quantity case rereads every source that was read before its latest
detection and passes when the rule clears on those reads across the same sources. A newly detected subject gets a diagnosis. Rules run independently, so an
unavailable source does not stop the others; failures retry on the next pass.
[Case workflows](workflows.md#case-workflows) may start runs for these cases, but closure
still needs this verification.

**Lost access.** A revoked or disconnected connection blocks its streams, so their reads
stop failing and would look clear. When a provider revoked a connection or removed its
grants (status `revoked` or `degraded` after it was last `active`, with no disconnect by a
person since), the stream reports when access was lost and the monitor opens one
high-severity `sync_failure` case for that connection, on its first stream, with reason
`access_lost`. A connection a person disconnected stays clear. Reconnecting keeps the
connection ID, and verification passes after a complete scan following the latest
detection. If someone disconnects the connection after access was lost, a person must
close the case.

## Persistence and lifecycle

All tables use forced tenant RLS. Runtime roles cannot update or delete source evidence,
configurations, inputs, evaluations or audit records (see
[database roles](development.md#database-roles)).

One transaction stores source evidence and normalized inputs before creating or updating
an incident. One advisory lock per tenant serializes evidence conflicts, fingerprint
updates and resolution; other tenants stay independent, but throughput within a busy
tenant is serialized. A partial unique index guarantees one unresolved incident per
fingerprint.

An evidence set adds at most one occurrence per fingerprint, including under concurrent
redelivery. New evidence updates the active incident; failed and escalated incidents stay
active. Resolved incidents are immutable: new evidence creates a successor linked to its
predecessor, and replaying old evidence cannot reopen it.

A clear or deferred decision never resolves an incident. Deferred subjects are reevaluated
after authoritative refreshes; after 30 minutes of uncertainty (default configuration)
the next evaluation escalates the existing incident or records an operator review task.
No mismatch is invented, and a certain result resets the window. A stock gap that waits for
provider sync (`propagation_pending`) also resets it: the wait is bounded by the rule, and
an escalation would turn normal sync into review work.

State changes and append-only audit events commit together in the exception outbox.
Detection never deletes or overwrites earlier connector snapshots.

## Resolution

There are two ways to resolve an incident:

- **Human disposition** requires `issues.manage`, a reason of 1–1000 characters and optional existing tenant evidence
  references (at most 100). It records the actor and never counts as autonomous verified success.
  Caller-supplied verification results are rejected.
- **Verification** asks the evaluator installed by the composition root, and fails closed
  when none is installed. The evaluator reads authoritative state itself; neither evidence
  nor success flags come from the request.

Each evaluator evidence item must bind to the incident's class, canonical subject, rule
identity and ordered scope, and its connection must match that scope. The required
postconditions are `complete_scan_checkpoint_advanced`, `fulfillment_disposition_verified`,
`equivalent_inventory_agrees` and `workflow_business_postcondition_verified`; order quantity
cases use the last, because their business outcome is every reporting source agreeing. They must be
established from source data; an accepted write receipt is insufficient.

Passing evidence must be complete, authoritative, independent of the detection evidence,
observed at or after the latest detection and within the freshness window. Failed,
partial, stale or inconclusive results leave the incident open. Mismatched evidence is
rejected. External reads run outside the transaction; a version check under the tenant
lock rejects the result if the incident changed meanwhile. Success atomically persists the
resolution, evaluator version, evidence bindings and an audit reference.
