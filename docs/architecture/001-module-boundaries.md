# ADR-001: Modular monolith boundaries

> Source layout and package placement are superseded by [ADR-005](005-domain-packages-and-runtimes.md). The dependency graph and domain ownership remain applicable.
>
> ts-rest is replaced by oRPC in [ADR-010](010-orpc-http-contracts.md).

Status: accepted for the initial backend. Decision: 2026-09-17, LUMA-4.

## Context and options

Luma must detect, diagnose, resolve and verify commerce exceptions across JTL and Shopify without recreating an ERP. The locked stack is one TypeScript/Node backend, Fastify, ts-rest, PostgreSQL/Drizzle and Better Auth. External systems initially remain authoritative for many commerce objects.

Choose explicit modules inside `apps/api/src/modules`, with dependency injection and a directed acyclic import graph. A flat service directory would make ownership hard to enforce. A package or microservice per module would add build, deployment and distributed transaction overhead before there is evidence for it. Create module directories only when implementing their first use case; this decision does not scaffold empty services.

## Module map and allowed imports

Rows are consumers; listed providers are the only permitted cross-module imports, including type-only imports and event schemas. Dependencies are not transitive permissions. Resolution imports the Workflow owner through its public contract. `identity` includes organizations and tenancy.

| Module      | Owns / public interface intent                                                                                                               | May import                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| platform    | Technical primitives, clock/ID/event ports, database, telemetry and model gateway ports/adapters; health                                     | none                                                                                                              |
| federation  | Verified external identities and reviewed OIDC adapters; no access grants                                                                    | none                                                                                                              |
| staff       | Isolated staff identities, support grants, inspection and audited account actions                                                            | platform, identity, federation                                                                                    |
| identity    | Users, organizations, membership, tenant/actor context; identity, the permission catalog and roles ([ADR-009](009-permissions-and-roles.md)) | platform                                                                                                          |
| audit       | Append-only evidence and audit queries; append/query ports                                                                                   | platform                                                                                                          |
| orders      | Canonical orders, lines and fulfillment references; ingest/query use cases                                                                   | platform, identity                                                                                                |
| sales       | Editable Luma-owned order records and atomic evidence publication                                                                            | platform, identity, audit, orders, connectors                                                                     |
| procurement | Authoritative suppliers, purchase orders, line records and audited lifecycle                                                                 | platform, identity, audit, connectors, execution, policies, workflows                                             |
| inventory   | Canonical SKU, stock positions and reservations; ingest/query use cases                                                                      | platform, identity                                                                                                |
| connectors  | Connections, secret references, external IDs, raw payloads/provenance, typed capabilities and normalized external observations               | platform, identity                                                                                                |
| customers   | Imported customer profiles: the current, erasable profile each connection reports                                                            | platform, identity                                                                                                |
| policies    | Policy versions, risk/permission decisions, approval requests and grants; evaluate/approve use cases                                         | platform, identity                                                                                                |
| execution   | Action attempts, idempotency, mechanism selection, verification and compensation; execute/status use cases                                   | platform, identity, policies, connectors, audit                                                                   |
| exceptions  | Incident lifecycle, diagnosis, proposed resolution and human escalation; detect/query/transition use cases                                   | platform, identity, orders, inventory                                                                             |
| workflows   | Workflow definitions, versions, activations, runs and provenance                                                                             | platform, identity, policies, execution, connectors                                                               |
| resolution  | Diagnosis and case coordination, proposals, learning, activity and overview                                                                  | workflows, procurement, platform, identity, orders, inventory, exceptions, policies, execution, connectors, audit |
| temporal    | Durable Resolution and process Workflow scheduling and replay                                                                                | resolution, workflows, identity, platform                                                                         |
| reads       | Read-only workspace views composed from owner-provided SQL; see ADR-008                                                                      | platform, identity, orders, exceptions, connectors, procurement, resolution                                       |
| sync        | Import and sync streams, checkpoints, the import ledger and source identity link requests                                                    | platform, identity, connectors, commerce, customers                                                               |
| assistant   | Workspace questions answered by a bounded model loop over read-only tools; no writes                                                         | platform, identity, reads, exceptions                                                                             |

Orders and inventory do not call each other. Resolution combines their snapshots. Connectors expose provider-independent observations/capabilities; commerce ingestion maps observations into owner-specific ingestion commands. Core modules must not branch on Shopify/JTL payloads. Execution owns action mechanics; workflows own the longer business process. Exceptions propose actions; execution checks current authorization, policy and approval before each external effect. Approval is not permission to bypass verification or audit.

Audit accepts generic evidence envelopes, not imports from every producer. Producers use an injected append port or committed events wired by the composition root. Platform must remain technical: it cannot own policies, commerce models, approvals or a generic business service locator.

## Public interfaces and layering

Each module uses this layout, adding files only as needed:

```text
modules/<name>/
  index.ts                 # explicit public DTOs, ports, event schemas and use-case types
  composition.ts           # factory wiring this module's adapters and handlers
  domain/                  # entities, value objects and pure rules
  application/             # use cases and ports they need
  infrastructure/          # database, vendor and durable-runtime adapters
  api/                     # HTTP handlers and transport mapping
```

- `domain` imports its own domain and the platform public primitives only.
- `application` imports its own application/domain and allowed providers' public interfaces.
- `infrastructure` imports its own infrastructure/application/domain and allowed providers' interfaces.
- `api` imports its own api/application/domain and allowed providers' interfaces; inject use cases rather than constructing repositories.
- `index.ts` exposes selected domain/application contracts with explicit named exports. No infrastructure, HTTP handlers, ORM tables, singleton instances or composition factories.
- `composition.ts` may wire all its own layers and consume allowed providers through their public interfaces. The application composition root lives in `apps/api/src/composition/`, with separate HTTP setup, runtime setup, service factories, and workflow setup. `app.ts` exposes these factories and `index.ts` starts the selected runtime. Composition files may only consume module entry points; backend modules cannot import the composition root.

Registered integration fixtures may wire module public/composition entry points: `app.test.ts`, `exceptions.integration.test.ts`, `commerce.integration.test.ts`, `commerce-sync.integration.test.ts`, `diagnosis-reread.test.ts`, `workflow-runtime.test.ts`, `resolution-learning.test.ts`, the connection test files and `test-support/detection-fixtures.ts`. They cannot import another module’s internal layers. The diagnosis reread fixture verifies the workflow-to-connector read boundary with a trusted identity context. The workflow runtime fixture verifies activity authorization, proposal freshness and tenant-scoped Temporal commands through module entry points. The resolution learning fixture tests public commands with an in-memory atomic storage adapter; PostgreSQL fixtures verify locking, retry matching and isolation.

All cross-module imports use `#modules/<provider>/index`. Never deep-import a provider, including from tests, or import its composition factory from another module. Factories receive provider interfaces from the root. Internal imports use extensionless `#modules/<module>/<layer>/<file>` paths. The API package declares these native Node imports, along with `#app` and `#test-support/*`. The `luma-source` condition resolves TypeScript source for development and tests; the default condition resolves compiled JavaScript for Node. TypeScript keeps `NodeNext` resolution. The boundary rule resolves these mappings before checking ownership and rejects undeclared aliases.

Domain, application and public entry points have no external runtime/framework imports. Inject clocks, I/O and vendor adapters. Colocated tests may import Vitest. Introduce any pure-library exception explicitly in the rule and this decision after review.

A public use case takes explicit tenant/actor context plus a validated command/query and returns a DTO or typed result. Never expose Drizzle rows or Fastify requests. Identity owns tenant/actor semantics; platform may own opaque identifier primitives without taking an identity dependency. HTTP contracts belong to `packages/api-contract`; web/desktop consume those contracts, never backend source. Transport DTOs must not become the domain model.

## Data, events and transactions

Each module owns its tables, migrations, repository interfaces and writes. A shared PostgreSQL connection does not permit direct access to another module's tables or repositories. Read through owner interfaces or build an explicitly owned projection. Keep transactions within an owner; workflows coordinate multiple owners with idempotent steps and explicit compensation rather than a transaction passed between modules.

The workflows resolution-learning projection reads retained diagnosis, admission, execution and verification records through tenant-scoped read grants. Workflows owns its run selections and operator facts; execution and exceptions retain ownership of verification writes. See [resolution learning](../resolution-learning.md) for the exported chain and storage boundaries.

Events describe committed facts, not commands disguised as notifications. The producing module owns a versioned public schema. Include event ID, type/version, tenant ID, occurrence time, correlation/causation IDs and minimal payload; use references for raw data and never carry credentials. Consumers import producer schemas only along the dependency map. A reverse dependency requires moving coordination to workflows or revising the ADR, not a string-topic workaround.

In-process dispatch is sufficient for ephemeral notifications. If a downstream effect must survive a crash, persist the business change and outbox record atomically, then dispatch after commit. Assume at-least-once delivery; consumers deduplicate by tenant/event ID, retry safely and expose terminal failures. Ordering is only promised per aggregate when explicitly implemented. Do not perform remote effects in a database transaction or let listener registration order define correctness. Durable workflows use provider-neutral application ports and Temporal infrastructure adapters (LUMA-29). Temporal owns process history, timers and activity delivery; owner modules retain authorization and effect idempotency. Audit history is append-only evidence, not default event sourcing.

Example: connectors records an external observation; workflows invokes orders/inventory ingestion, asks exceptions to diagnose, then requests execution. Execution checks policies, invokes a connector capability, verifies the result and records evidence. Workflows updates the exception outcome through its interface. No reverse import is needed.

## Shared primitives and enforcement

Group infrastructure files by responsibility when several files implement one feature:

- `connectors/infrastructure/installations` owns credential storage, input validation, verification, and installed adapter wiring. Provider protocol clients and schemas live in `packages/connectors/jtl` and `packages/connectors/shopify`; local provider folders adapt their results to Luma capabilities.
- `workflows/infrastructure/playbooks` owns playbook validation and persistence.
- `packages/workflow-temporal/src` owns worker setup and durable workflow execution. Keep the worker entry point beside its runtime loader.
- `resolution/infrastructure/persistence` owns operator desk and resolution learning storage.

Nested folders retain their layer's dependency rules. Other modules use `index.ts`; application wiring uses `composition.ts`. File moves must update runtime paths and development watch paths as well as imports.

Define consumed service contracts explicitly in the application layer and annotate their factories. Use interface extension for a larger contract, such as trusted installation operations extending connection management. Prefer injected functions and composed adapters for shared behavior; introduce a base class only when implementations share lifecycle invariants that it can enforce. Keep recurring helpers with their semantic owner.

Extract a workspace package when it has a coherent public API and an independent consumer or build lifecycle. Shared HTTP contracts, configuration, and UI already meet that bar. Installation and workflow adapters remain owned by their modules; a folder split does not require a package or a new dependency edge.

Keep a primitive with its semantic owner. Share only after a concrete second consumer exists. Platform owns technical interfaces; identity owns tenant context; audit owns evidence contracts; connectors owns capability descriptions; policies owns approval/decision semantics. Existing `packages/config` remains startup configuration, consumed by the composition root. Inject configuration into modules. `packages/ui` remains presentation-only. Packages must not import apps, and apps must not import another app's source.

The provider packages expose compiled JavaScript and declarations through explicit exports. `@luma/connector-jtl` and `@luma/connector-shopify` own protocol clients and provider response schemas. Shopify also owns OAuth token exchange, callback signatures, and webhook signature verification. They accept credentials and transports from callers and never import API source or access tenant storage. The API owns authorization, OAuth state and app/environment binding, connection lifecycle, capability mappings, observation persistence, and webhook refresh scheduling.

`@luma/connector-core` owns the shared failure contract and transport helpers used by both providers. Its root export has no runtime dependencies; schema parsing lives in the separate `/transport` export. The connectors module may use the core failure contract in its inner layers, while provider packages, provider `/schemas` exports, and core `/transport` are restricted to its infrastructure and composition layers. Other backend modules consume the connectors module's public interface. Package imports use `@luma/connector-*`; relative source imports are not a substitute for public package exports.

`tooling/architecture/policy.mjs` is the executable dependency/layer map. The local ESLint rule runs in `pnpm lint` and CI. It checks module registration, public entry points, import directions, layer directions, external dependencies in inner layers, static imports/re-exports, type imports, literal dynamic imports and `require`. Nonliteral module imports are rejected. The `api` layer may import the root `@luma/api-contract` export for HTTP schemas; all other layers and contract subpath imports remain forbidden. This narrow exception keeps transport mapping out of inner layers. Backend modules cannot import or re-export `node:module` or `module`, including through dynamic imports or `require`; this prohibits alternate loaders such as `createRequire` regardless of local aliases. Use standard imports or literal `require` calls instead. `pnpm test:architecture` exercises allowed and forbidden imports and checks the graph for cycles; it is included in `pnpm test`.

This is a source-level guard, not a security sandbox. Review must still enforce table ownership, event semantics, tenant scoping, explicit public exports, package responsibilities and runtime capability authorization. Do not introduce import aliases, computed loaders, ESLint suppressions or alternate module roots to evade the policy. A new module, dependency, alias or exception requires updating the ADR, executable policy and regression tests together.

## Consequences, reversal cost and evidence

The graph makes ownership reviewable while keeping a single deployable backend. Workflows bears explicit coordination work; public DTOs may duplicate transport/storage shapes. Dependencies can be changed with a reviewed ADR and policy update; moving a module to its own process later additionally requires replacing injected ports with transport and validating delivery/transaction guarantees.

Evidence: the existing backend contains only startup and a service-free health endpoint, so no domain migration is needed. Boundary regression tests cover legal imports and violations, and CI runs them with the existing repository gates. This decision makes no claim about throughput or durable-runtime reliability; provider spikes and LUMA-7/LUMA-16 remain separate work.

Sources: [Linear architecture register](https://linear.app/auren-labs/document/architecture-decision-register-305db9bed1de), [strategic decision log](https://app.notion.com/p/3dd56a47048481afa32bfc5e75ba94b1), [product architecture](https://app.notion.com/p/3dd56a4704848195bbaad3dbd757e9af).
