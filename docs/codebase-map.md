# Codebase map

Find the owner here, then follow imports and search inside it. Names are consistent
across layers, so one feature term (`returns`, `decisions`, `replenishment`) usually finds
its contract, routes, read model, web feature, tests and stories. This map lists owners and
conventions only; it does not list files.

## Owners

| Area                                                                                            | Owner                                                                                    |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Sign-in, workspaces, memberships, roles, settings                                               | `@luma/identity`                                                                         |
| Reviewed Google Workspace/OIDC federation adapters                                              | `@luma/identity-provider`                                                                |
| Staff identities, support access, inspection and account actions                                | `@luma/staff`                                                                            |
| Action policy and approval requirements                                                         | `@luma/policies`                                                                         |
| Action admission, effects, idempotency                                                          | `@luma/execution`                                                                        |
| Append-only audit log                                                                           | `@luma/audit`                                                                            |
| Installed connections, credentials, capabilities, observations                                  | `@luma/connections`                                                                      |
| Provider apps (setup, adapters, OAuth, webhooks, app UI)                                        | `packages/apps/<id>`, contracts in `@luma/app-host`, registration in `@luma/app-catalog` |
| Provider protocol clients                                                                       | `packages/connectors/*`                                                                  |
| Editable Luma order records                                                                     | `@luma/sales`                                                                            |
| Canonical orders, fulfillment, returns, refunds, return cases                                   | `@luma/orders`                                                                           |
| Canonical SKUs, locations, stock, product catalog rows                                          | `@luma/inventory`                                                                        |
| Customer profiles                                                                               | `@luma/customers`                                                                        |
| Observation → canonical projection                                                              | `@luma/commerce-ingestion`                                                               |
| History import, incremental sync, reconciliation                                                | `@luma/commerce-sync`                                                                    |
| Detection rules, cases, evidence, diagnosis, verification                                       | `@luma/exceptions`                                                                       |
| Case desk, proposals, learning, measurement, activity                                           | `@luma/resolution`                                                                       |
| Workflow definitions, subscriptions, tasks, event waits, versions, activations, runs, authoring | `@luma/workflows`; durable execution in `@luma/workflow-temporal`                        |
| Suppliers, purchase orders, replenishment, commitments                                          | `@luma/procurement`                                                                      |
| Mailboxes, message threads, links, documents and replies                                        | `@luma/messaging`                                                                        |
| Cross-owner read-only views (workspaces, metrics, Needs you)                                    | `@luma/read-models`                                                                      |
| Ask Luma                                                                                        | `@luma/assistant`                                                                        |
| Service composition, process runtimes, migrations                                               | `@luma/application-runtime`                                                              |
| HTTP schemas, typed client, OpenAPI                                                             | `@luma/api-contract`                                                                     |
| Shared technical infrastructure, model gateway                                                  | `@luma/platform`; validated settings in `@luma/config`                                   |
| Shared components and design tokens                                                             | `@luma/ui`                                                                               |
| Interface languages, message catalogs, formatting                                               | `@luma/i18n`                                                                             |
| Email templates, shared email layout and previews                                               | `@luma/email`; sending and queues in `@luma/identity`                                    |

Processes: `apps/api` (HTTP), `apps/worker` (Temporal worker and the commerce sync process
with scheduled detection), `apps/web` (product UI), `apps/simulator` and
`apps/simulator-web` (synthetic providers), and `apps/staff-api` / `apps/staff` (isolated staff API and web application). Local environments live in `tooling/pilot` and
`tooling/simulator`.

## Conventions

- **Layers:** domain packages split `src` into `domain` (rules), `application` (use cases,
  ports), `infrastructure` (PostgreSQL and provider access) and, when they serve HTTP,
  `api` (routes). Other packages import the root export, `/composition` for constructors
  and `/http` for route registration.
- **Contracts:** `packages/api-contract/src/<feature>.ts` for schemas and `contracts/` for
  routes.
- **Web features:** `apps/web/src/features/<feature>`, usually with `page.tsx`,
  `detail.tsx`, URL state in `data.ts` and wording in `presentation.ts`; text comes from the
  feature's namespace in the `@luma/i18n` catalogs. The workspace shell, navigation, command
  menu and Home are in `apps/web/src/shell`; session, permissions and workspace-wide data in
  `kit`; building blocks several features share in `shared`. See
  [web app layers](frontend-ui.md#web-app-layers).
- **Migrations:** numbered SQL in `packages/application-runtime/migrations`; the simulator
  has its own in `apps/simulator/migrations`.
- **Wiring:** `packages/application-runtime/src/composition` assembles services for the API,
  worker, pilot and simulator. A fix in one composition path may be missing in another.
- **Tests:** unit tests sit next to the code. Database integration tests are
  `packages/application-runtime/src/*.integration.test.ts`. Backend journeys are
  `apps/api/e2e/*.e2e.mjs`, browser journeys `*.browser.mjs`, and both share fixtures in
  that directory; `journey-areas.mjs` maps them to the source they exercise. Stories sit
  next to components.
- **Docs:** feature guides are listed in the [docs index](README.md); product guides
  are in `apps/web/content/docs`.

## Operational issue flow

**Provider state → observation → detection → case → recovery → fresh verification**

Adapters read provider state through installed capabilities and record observations with
completeness and freshness. Commerce sync projects them into canonical records. The
scheduled detection monitor in the sync process evaluates exception rules on complete,
current evidence and opens cases. Recovery runs through policy admission, approval and
execution. Only a separate, fresh verification read closes a case; a successful provider
write does not.

The pilot and simulator run the same services. They cover sync failures, linked stock and
stuck fulfillment, not every exception type; the simulator scorecard shows which incident
kinds Luma detects. Before adding a scenario, check that its collection, detection,
diagnosis and verification are actually wired. See
[adding an operational scenario](adding-operational-scenarios.md).

## Placement rules

- Business decisions go in domain files, use cases and ports in application files, and
  provider or database access in infrastructure files.
- Composition roots wire services; they do not own rules. Domain code must not depend on
  the simulator or runtime composition.
- Keep provider protocol behavior in its simulator provider package and coordinate providers
  in the simulator host.
- Reuse test identity and database provisioning. Assert real evidence and case transitions
  through application services or HTTP.

See the [architecture decisions](architecture/README.md) for boundaries and
[local development](development.md) for commands.
