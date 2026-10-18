# Synthetic pilot environment

The pilot runs the real web app, HTTP API, PostgreSQL services and Temporal workflows against synthetic provider state, so approval, execution, verification and recovery can be exercised without provider, model or telemetry credentials. Provider calls go to an injected fetch function that cannot reach JTL or Shopify; production entry points and configuration are unchanged. Pilot commands also export to the [local diagnostics stack](observability.md#pilot-and-simulator). For a full simulated merchant with sync, webhooks and a scorecard, use the [commerce simulator](simulator.md), which runs on the same pilot runtime.

## Start

```sh
pnpm run setup
pnpm pilot:seed
pnpm pilot
# In a second terminal:
pnpm pilot:worker
```

Open the printed web URL and sign in as `pilot-operator@example.test` with the password in `.luma/demo.json`, then select **Synthetic pilot · approval-required**. The requester, `pilot-requester@example.test`, uses the same password and owns the organization; the operator is an admin. `pilot-warehouse@example.test`, a member, answers the tasks workflows hand to the warehouse. High-risk actions need approval from a different user than the requester. All accounts are synthetic; a pilot seeded before the warehouse member existed needs `pnpm pilot:reset` to get it.

The API and worker use a dedicated Temporal task queue per pilot run, so `pnpm dev:workflows`' ordinary worker does not pick up pilot work; use `pilot:worker`. The pilot shares this checkout's web and API ports with `pnpm dev`, so stop one before starting the other. The worker prints its PID for the recovery drill.

## Hostname and Tailscale

Set the browser-facing origin in `apps/api/.env`, using your machine's Tailscale hostname:

```dotenv
BETTER_AUTH_URL=https://<machine>.<tailnet>.ts.net
```

The value needs `http://` or `https://` and no path or trailing slash. `SHOPIFY_WEB_ORIGIN`, when set, takes precedence; set it to the same origin or remove it. Without either, the pilot uses its loopback URL. Restart both pilot commands after changing the origin; the pilot uses it for authentication and allows its hostname in the web development server.

Forward Tailscale HTTPS to the printed **Local web target**, then open the printed **Web** URL from a device on your tailnet:

```sh
tailscale serve --bg http://127.0.0.1:<web-port>
```

The web server proxies API requests to the local API. Passkeys bind to this hostname; see [sign-in factors](identity.md#sign-in-factors).

## Repeat and reset

`pnpm pilot:seed` is idempotent: it keeps the current manifest, organization, evidence and provider state. To start a fresh scenario, stop both pilot commands, run `pnpm pilot:reset <scenario>`, then start `pnpm pilot` and `pnpm pilot:worker` again and select the new organization.

Reset creates a new organization, case IDs, provider file and task queue. It keeps earlier runs and their audit history, and never deletes databases or rewrites existing approvals.

- `.luma/pilot.json` identifies the current run, users, connections, proposal and cases.
- `.luma/provider-<runId>.json` holds the simulated provider state: normalized observations, committed effects and the PATCH request count. It keeps only the 200 most recent observations and capability events; the database stores ingested observations separately.

Keep these files out of Git.

## Scenarios

| Scenario            | Reproducible result                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `healthy`           | No incidents or writes. Connection coverage remains unobserved.                                                 |
| `decisions-needed`  | Four diagnosed cases with evidence and manual next steps.                                                       |
| `diagnosis-pending` | The workflow failure keeps its queued diagnosis; no workflow starts.                                            |
| `uncertain`         | An interrupted workflow lacks durable evidence. Diagnosis needs investigation; no proposal or write occurs.     |
| `approval-required` | Temporal waits for the operator's approval or rejection. The default.                                           |
| `rejected`          | The separate operator rejects; policy denies execution.                                                         |
| `executing`         | After approval, the provider delays PATCH for 20 seconds, exposing executing progress, then completes.          |
| `verifying`         | After the write, business verification waits 20 seconds. The case stays unresolved until the fresh read passes. |
| `resolved`          | The operator approves; one PATCH and independent reads produce a verified resolution.                           |
| `failed`            | PATCH returns a conflict. The workflow escalates and the case stays unresolved.                                 |
| `recovery`          | The provider commits, then delays and loses its response. See [worker recovery](#worker-failure-and-recovery).  |

Except for `healthy`, each run includes a connector authentication failure, stuck fulfillment, an inventory mismatch and an exhausted workflow failure. Only the workflow failure leads to the shipping correction; the other cases are there for inspection. Automatic scenarios record real operator decisions and audit entries; `approval-required` leaves the decision to the signed-in operator.

## The selected action

The failed workflow step is `correct-order-shipping-method`: synthetic JTL order 10 has shipping method 7, and the intended method is 8. The correction runs through the real path, as a [resolution playbook](resolution-playbooks.md) with persisted version, activation, input and evidence snapshot and step outcomes:

- The `orders.shipping-method.write` adapter requires a matching pre-action read, disables automatic JTL workflows and sends a tenant-scoped idempotency key.
- The policy service requires approval from another user, and the execution service reserves and persists the action before dispatch.
- The adapter rereads the order after writing. A separate business verifier rereads it again and resolves only this workflow's shipping-method postcondition. It does not claim the order shipped or resolve the separate stuck-fulfillment case.
- The action supports reversal through a new approved intent; a pilot reset provides a new synthetic order with the original method.

Evidence dates shift together from the fixture corpus to the run's creation time. Inventory, fulfillment and shipping evidence keep a five-minute freshness window. While an unapproved correction waits, Luma rereads the order and prepares a new immutable proposal when evidence needs updating, and current conditions are checked again before approval, so a long review never requires a reset. If an approval expires before execution, fresh evidence produces a new proposal that needs a new independent approval. Changed, cancelled, shipped or unknown order states block the correction. Temporary read failures can be retried without recording an approval.

## What is synthetic

Both connection labels begin with **SIMULATED** and report no live health, so the overview shows unobserved connection coverage; a healthy synthetic workload never implies healthy connected systems. Simulator runs also connect a synthetic [operations mailbox](simulator.md#operations-mailbox) with the same label; Luma reads its mail by polling because Gmail push is not simulated. Every seeded evidence document carries `synthetic: true`, and the organization name identifies the simulation. The inventory mismatch pairs JTL availability with a Shopify fixture location by assumption, not through a discovered mapping.

Disconnecting or revoking the seeded JTL connection disables approval and prevents dispatch, even for an already approved action. Simulated health checks accept only this run's seeded connections; other connections are rejected without changing their stored health or lifecycle history.

## Worker failure and recovery

```sh
pnpm pilot:reset recovery
pnpm pilot
# Second terminal:
pnpm pilot:worker
```

The scenario approves the correction automatically. When the worker prints `PILOT_EFFECT_COMMITTED`, run `kill -KILL <worker-pid>` with the PID it printed, then restart `pnpm pilot:worker` without resetting. Allow up to 90 seconds for Temporal's activity heartbeat timeout and retry. The execution receipt forces read-only reconciliation, so the action is not dispatched again, and the case resolves after the independent business read. The provider file must show exactly one effect and `patchRequests: 1`. If you don't kill the worker, the simulated lost response exercises the same reconciliation after 40 seconds. Never kill the API or database for this drill.

## Reusing the pilot in tests

Backend journeys import `seedPilot`, `createPilot`, `startJourney` and `respond` from `tooling/pilot/`. Supply a restricted, migrated test database, generated auth and connection-encryption settings, an isolated output directory and Temporal settings. `seedPilot` returns every tenant, case and proposal ID, so tests need no hard-coded rows. Call `close()` on services, clients and workers.

The pilot is a local synthetic environment, not a deployment command. A real pilot needs approved EU PostgreSQL and Temporal services and real connectors configured through their integration guides.
