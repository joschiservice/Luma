# Synthetic pilot environment

The pilot runs the real web app, HTTP API, PostgreSQL services and Temporal
workflow. JTL responses and writes use local fixture files. No provider, model or
telemetry credentials are needed. Use Node 24, pnpm 12 and Docker.

## Start

```sh
pnpm run setup
pnpm pilot:seed
pnpm pilot
# In a second terminal:
pnpm pilot:worker
```

Open the printed web URL. Sign in as `pilot-operator@example.test` with the
password in `.luma/demo.json`, then select **Synthetic pilot · approval-required**.
The requester is `pilot-requester@example.test`, with the same local password.
The requester owns the organization; the operator is an admin. A different user
must approve the high-risk action. Both accounts are synthetic.

The worker prints its PID. The API and worker use a dedicated task queue for each
pilot run. `pnpm dev:workflows` starts the ordinary worker; use `pilot:worker` for
these fixture bindings. Stop an ordinary development server before starting the
pilot because they share this checkout's web/API ports.

## Hostname and Tailscale

Set the browser-facing origin in `apps/api/.env`:

```dotenv
BETTER_AUTH_URL=https://luma-dev.tail2dda1b.ts.net
```

Use your machine's Tailscale hostname. The value must include `http://` or
`https://`, with no path or trailing slash. If `SHOPIFY_WEB_ORIGIN` is set, it
takes precedence; set it to the same origin or remove it. Without either setting,
the pilot uses its local loopback URL.

Restart `pnpm pilot` and `pnpm pilot:worker` after changing the origin. The pilot
uses it for authentication and allows its hostname in the web development server.
Forward Tailscale HTTPS traffic to the printed **Local web target**:

```sh
tailscale serve --bg http://127.0.0.1:<web-port>
```

Replace `<web-port>` with the printed port, then open the printed **Web** URL from
a device on your tailnet. The web server proxies API requests to the local API.

## Repeat and reset

`pnpm pilot:seed` preserves the current manifest, organization, evidence and
provider state. Stop both pilot commands, then select a fresh scenario:

```sh
pnpm pilot:reset resolved
pnpm pilot
# Second terminal:
pnpm pilot:worker
```

Reset creates a new organization, case IDs, provider file and Temporal task queue.
It retains earlier runs and their audit history. It does not delete databases or
rewrite existing approvals. Select the new organization after reset.
`.luma/pilot.json` identifies the current run, users, connections, proposal and
cases. `.luma/provider-<runId>.json` contains simulated provider state, normalized
observations, committed effects and the PATCH request count. Keep these local
files out of Git.

Evidence dates move together from the golden corpus to the run's creation time.
Inventory and fulfillment evidence retains its normal five-minute freshness
window. The shipping proposal also expires after five minutes. Reset for a fresh
demo; restarting a worker never extends an approval or an expired proposal.

## Scenarios

Pass one of these names to `pnpm pilot:reset <scenario>`:

| Scenario            | Reproducible result                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `healthy`           | No incidents or writes. Connection coverage remains unobserved.                                                 |
| `decisions-needed`  | Four diagnosed cases with evidence and manual next steps.                                                       |
| `diagnosis-pending` | The workflow failure retains its queued diagnosis; no workflow starts.                                          |
| `uncertain`         | An interrupted workflow lacks durable evidence. Diagnosis requires investigation; no proposal or write occurs.  |
| `approval-required` | Temporal waits for the operator's approval or rejection. This is the default.                                   |
| `rejected`          | The separate operator rejects through the desk service; policy denies execution.                                |
| `executing`         | After approval, the provider delays PATCH for 20 seconds, exposing executing progress. Then it completes.       |
| `verifying`         | After the write, business verification waits 20 seconds. The case stays unresolved until the fresh read passes. |
| `resolved`          | The operator approves; one PATCH and independent reads produce a verified resolution.                           |
| `failed`            | PATCH returns a conflict. The workflow escalates and the case remains unresolved.                               |
| `recovery`          | The provider commits, then delays and loses its response. Restart the worker to exercise reconciliation.        |

Except for `healthy`, each run includes connector authentication failure, stuck
fulfillment, inventory mismatch and exhausted workflow failure. Only the workflow
failure participates in the shipping correction. The other cases remain available
for inspection. Automatic scenarios record real operator decisions and audit
entries; `approval-required` leaves that decision to the signed-in operator.

## Selected safe action

The failed workflow step is `correct-order-shipping-method`. Its synthetic JTL
order 10 has shipping method 7; the intended method is 8. The existing
`orders.shipping-method.write` adapter requires a matching pre-action read,
disables automatic JTL workflows, and sends a tenant-scoped idempotency key. The
real policy service requires approval from another user. The real execution
service reserves and persists the action before dispatch.

The execution adapter independently rereads the order. A separate business
verifier then rereads through the adapter and resolves only this workflow's
shipping-method postcondition. It does not claim that a shipment was completed,
or resolve the separate stuck-fulfillment case. The underlying action supports
reversal with a new approved intent; pilot reset provides a new synthetic order
with the original method.

JTL order/product data and Shopify inventory identifiers and quantities reuse
`apps/api/src/modules/connectors/infrastructure/{jtl,shopify}/fixtures/commerce.json`.
Detection facts reuse `docs/fixtures/exceptions-v0.json`. The explicit synthetic
inventory mapping relates the JTL available pool to Shopify location 42 and
normalizes both to `each`. It is a fixture assumption, not a discovered mapping.
No live inventory or connector health is inferred from it.

Both connection labels begin with **SIMULATED**, and their configurations remain
pending. The overview therefore reports unobserved connection coverage. A healthy
synthetic workload does not imply healthy connected systems. Every seeded evidence
document carries `synthetic: true`; the organization name also identifies the
simulation. Disconnecting or revoking the seeded JTL connection disables approval
and prevents dispatch, including for an already approved action. Simulated health
checks accept only this run's seeded connections; other connections are rejected
without changing their stored health or lifecycle history.

The pilot uses an injected fetch function that cannot send requests
to JTL or Shopify. Production entrypoints and configuration are unchanged.

## Worker failure and recovery

```sh
pnpm pilot:reset recovery
pnpm pilot
# Second terminal:
pnpm pilot:worker
```

When the worker prints `PILOT_EFFECT_COMMITTED`, run `kill -KILL <worker-pid>` using
the PID it printed. Restart with `pnpm pilot:worker` without resetting. Allow up
to 90 seconds for Temporal's activity timeout and retry. The execution receipt
forces read-only reconciliation; the original action is not dispatched again.
The case resolves after the independent business read. The provider file must
contain exactly one effect and `patchRequests: 1`. If you do not kill the worker,
the simulated lost response exercises the same reconciliation path after 40
seconds. Never kill the API or database for this reproduction.

## Backend acceptance and reuse

`pnpm test:e2e` runs `apps/api/e2e/pilot.e2e.mjs` against disposable PostgreSQL and
a real local Temporal server. It checks idempotent seeding, each scenario,
separate-user approval, rejection, independent verified resolution, transient
progress, and process death after provider commit without a second PATCH.

LUMA-25 can import `seedPilot`, `createPilot`, `startJourney` and `respond` from
`tooling/pilot/`. Supply a restricted migrated test database, generated auth and
connection encryption settings, an isolated output directory, and Temporal
settings. `seedPilot` returns all tenant/case/proposal IDs, so consumers need no
hard-coded database rows. Call `close()` on services, clients and workers.

LUMA-37 owns complete browser acceptance. These backend scenarios establish
fixture and environment behavior; they do not establish usability of every
operator screen. For a real pilot deployment, provision approved EU PostgreSQL
and Temporal services and configure real connectors using their integration
guides. This local synthetic command is not a production deployment command.
