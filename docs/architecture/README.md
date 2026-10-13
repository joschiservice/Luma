# Architecture decisions

Implementation decisions are recorded here and versioned with the code they govern. Linear
holds short summaries and links to these files; Notion holds strategic product and business
decisions.

## Register

| ADR                                               | Decision                                                   | Status                             |
| ------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------- |
| [001](001-module-boundaries.md)                   | Modular monolith boundaries                                | Accepted; layout superseded by 005 |
| [002](002-canonical-commerce-model.md)            | Canonical commerce data model v0                           | Accepted                           |
| [003](003-tenant-isolation-and-data-residency.md) | Tenant isolation and regional data residency               | Proposed                           |
| [003 review](003-model-processing-path-review.md) | ADR-003 applied to the Bedrock EU route for tenant prompts | Pending operator sign-off          |
| [004](004-browser-runtime.md)                     | Browser runtime and managed provider                       | Proposed                           |
| [005](005-domain-packages-and-runtimes.md)        | Domain packages and process composition                    | Accepted                           |
| [006](006-workspace-apps.md)                      | First-party workspace apps                                 | Accepted                           |
| [007](007-workflow-model.md)                      | First-class Workflow ownership                             | Accepted                           |
| [008](008-workspace-read-models.md)               | Workspace read models                                      | Accepted                           |
| [009](009-permissions-and-roles.md)               | Permission catalog and workspace roles                     | Accepted                           |
| [010](010-orpc-http-contracts.md)                 | HTTP contracts with oRPC and one Zod version               | Accepted                           |
| [011](011-support-view.md)                        | Read-only support view                                     | Accepted                           |

| [012](012-native-order-records.md) | Native order records and source evidence | Accepted |
| [013](013-stock-ledger.md) | Quantity ledger and stock ownership | Accepted |
| [014](014-adaptive-workspaces.md) | Adaptive workspaces and operational packages | Accepted |

## Baseline

- TypeScript and Node.js; Fastify; contract-first REST and OpenAPI through oRPC.
- PostgreSQL with Drizzle; Better Auth; modular monolith first.
- TanStack Start for the web app; Vercel primarily for frontend delivery.
- A canonical commerce model kept separate from provider payloads.
- EU data residency by default; regional data planes later.
- Sentry, Langfuse and PostHog.
- Execution preference: provider API, deterministic browser automation, agentic browser or
  computer use, then human escalation.
- Open: V0 PostgreSQL hosting, Neon Frankfurt or an AWS-managed alternative.

## Writing an ADR

Write one when a decision is material, cross-cutting or expensive to reverse. Give it the
next number and include status and date, context, the options considered, the decision,
consequences, reversal cost and evidence. Add it to the register.

ADRs record a decision at a point in time. Mark a replaced decision as superseded and link
its successor instead of rewriting it. Day-to-day feature rules belong in the
[engineering guides](../README.md).
