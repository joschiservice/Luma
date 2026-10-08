# ADR-005: Domain packages and process composition

Status: Accepted. Date: 2026-09-23.

## Decision

Luma remains a modular monolith with one PostgreSQL schema history. Domain packages enforce public contracts; API and worker are separate executable applications. This supersedes ADR-001's source layout and package placement, while retaining its domain dependency directions and tenant isolation rules.

| Owner                                                                      | Responsibility                                                                                  |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/api`                                                                 | HTTP process configuration, instrumentation, listening, signals                                 |
| `apps/worker`                                                              | Temporal worker configuration, instrumentation, running, signals                                |
| `packages/application-runtime`                                             | Typed service assembly, resource ownership, API and worker runtime builders, ordered migrations |
| `packages/resolution`                                                      | Case desk, proposals, approval orchestration, learning, activity and overview queries           |
| `packages/commerce-ingestion`                                              | Replayable orchestration from provider observations to canonical projections                    |
| `packages/workflows`                                                       | Workflow definitions, immutable versions, scoped activations, runs and provenance               |
| `packages/workflow-temporal`                                               | Durable workflow implementation and Temporal client/worker adapters                             |
| `packages/connections`                                                     | Installation lifecycle, credentials, capability adapters, source mappings and coverage          |
| `packages/{identity,audit,orders,inventory,exceptions,policies,execution}` | Their existing domain rules, ports, persistence and public service contracts                    |
| `packages/platform`                                                        | Tenant database abstraction and technical observability/model infrastructure                    |
| `tooling/pilot`                                                            | Synthetic provider behavior, fixture provisioning and scenario orchestration                    |

The staff frontend and API run separately from the customer applications. Staff owns its sessions, grants and support evidence; the identity owner exposes only the controlled account operation. The shared identity-provider package verifies external identities without granting application access.

The existing connector SDKs and simulator packages retain their independent provider boundaries. Simulated transport continues to exercise installed connectors and the real policy/execution path.

## Public interfaces and transport boundaries

Domain root exports contain domain/application contracts. `/composition` exposes construction functions. `/http` exposes HTTP adapters separately; service constructors do not import route modules. `connections/adapters` is the explicit provider-construction surface for transport fixtures. No wildcard exports expose internal source directories.

Resolution and diagnosis persistence validate stored documents with shared API-contract schemas through dedicated infrastructure validators. These are explicit boundary exceptions, not permission for application/domain code to depend on HTTP contracts. HTTP routes and Fastify registration remain outside application services.

Commerce ingestion depends on owner interfaces. The Temporal adapter depends on resolution contracts; resolution does not depend on Temporal. Application runtime composes these packages and must not become the owner of new business rules.

The architecture linter enforces package and layer directions. The logical module name `connectors` identifies connections. Resolution and Workflows have separate entries in the dependency policy; see [ADR-007](007-workflow-model.md). Regression fixtures also cover the former source layout to retain the existing boundary checks.

## Composition and capabilities

`createApplicationServices` is the authoritative service graph for normal development, pilot and simulator. It accepts a tenant database, identity, optional verification/desk dependencies, and explicit execution configuration. Constructing it does not provision grants or open resources. `execution.kind = 'disabled'` installs an effect registry that resolves no actions; migration does not enable live writes.

`buildRuntimeApp` is asynchronous so failed initialization can finish resource cleanup before rejecting. Normal API and worker construct resources for their process. The pilot selects its process role explicitly; its worker does not construct an HTTP server.

Resource scopes drain in reverse acquisition order, attempt every close even after failures, and share repeated shutdown calls. Identity and workflow database credentials remain separate. Pools are not merged across privilege boundaries.

## Persistence ownership

Each domain owns writes to its tables. Connections owns installations and source mappings; orders and inventory own canonical projections; exceptions owns incidents/diagnoses; policies owns decisions/approvals; execution owns admission/execution records; resolution owns case commands, proposals and learning records; workflows owns definition, version, activation, run and outcome records; audit owns append-only audit records; identity owns authentication and membership data.

Cross-domain reads are allowed only in deliberate query/persistence adapters, including desk snapshots, activity history and learning reads. These adapters have schema dependencies even when the TypeScript import graph does not show them. Changes to those tables must run their integration tests.

Case decisions, policy responses and command receipts retain their existing shared transaction. Playbook activation review retains its transaction and locking. Owner operations receive a transaction-scoped database; they must not silently open another transaction or pool. Commerce ingestion retains separate idempotent owner transactions and replay after partial failure. Package extraction does not replace these with remote calls or eventual consistency.

One ordered migration runner lives in `packages/application-runtime`. Applied filenames and checksums remain unchanged. Runtime roles cannot migrate the database. Domain ownership does not imply independent migration execution or separate databases.

## Fixtures and durable notifications

Initial pilot playbook publication and activation happen in `seedPilot`, before saving a new manifest. Loading a saved manifest and restarting API/worker processes do not recreate grants. Scenario resets remain explicit. Proposal refresh is a typed resolution use case; synthetic target mappings, detector fixture inputs and forced provider faults remain in tooling.

Approval notifications are wake-up hints. PostgreSQL persists the decision before notification; Temporal polling recovers lost hints. Preserve this mechanism and its tests rather than introducing another delivery system as part of package extraction.

## Verification

Run `pnpm check`, `pnpm test:e2e`, `pnpm test:browser`, and `pnpm test:simulator`. Database tests run against disposable PostgreSQL through the normal test command. Temporal integration tests execute the extracted workflow adapter. Check resource cleanup, restricted-role readiness, approval/revocation, replay and uncertain-write reconciliation when changing composition.

Packages expose source conditions for local development and Vitest, with compiled JavaScript/declarations for ordinary Node execution. Build through Turbo to respect the package graph. API and worker watch shared package source during development.
