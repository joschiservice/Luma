# Architecture decisions

This directory is the source of truth for implementation ADRs. Review and version decisions alongside the code they govern. Linear holds short summaries, related issues and repository links; do not maintain full ADR copies there. Notion remains the source of truth for strategic product and business decisions.

## Register

| ADR                                               | Decision                                               | Status   | Issue                                                |
| ------------------------------------------------- | ------------------------------------------------------ | -------- | ---------------------------------------------------- |
| [001](001-module-boundaries.md)                   | Modular monolith boundaries                            | Accepted | [LUMA-4](https://linear.app/auren-labs/issue/LUMA-4) |
| [002](002-canonical-commerce-model.md)            | Canonical commerce data model v0                       | Accepted | [LUMA-5](https://linear.app/auren-labs/issue/LUMA-5) |
| [003](003-tenant-isolation-and-data-residency.md) | Tenant isolation and regional data residency           | Proposed | [LUMA-6](https://linear.app/auren-labs/issue/LUMA-6) |
| [004](004-browser-runtime.md)                     | Browserbase V0 with Playwright/CDP; Anchor alternative | Proposed | [LUMA-2](https://linear.app/auren-labs/issue/LUMA-2) |

[ADR-005](005-domain-packages-and-runtimes.md) defines the accepted domain package layout, API/worker processes, shared composition and persistence ownership. It supersedes ADR-001’s source placement.

## Baseline

Carried forward from the [Linear architecture register](https://linear.app/auren-labs/document/architecture-decision-register-305db9bed1de):

- TypeScript + Node.js; Fastify; contract-first REST/OpenAPI via ts-rest.
- PostgreSQL + Drizzle; Better Auth; modular monolith first.
- TanStack Start for the current web app; Vercel primarily for frontend delivery.
- Canonical commerce model with separate connector payloads.
- EU data residency by default; regional data planes later.
- Sentry, Langfuse and PostHog.
- Execution preference: API, deterministic browser automation, agentic browser/computer use, then human escalation.

## Pending decisions

- Restate versus Temporal for durable execution.
- V0 PostgreSQL hosting: Neon Frankfurt versus an AWS-managed alternative.

## Maintaining ADRs

Create a numbered Markdown file for each material decision. Include status/date, context, options considered, decision, consequences, reversal cost, evidence and related Linear issues. Add it to this register. Preserve decision history; mark replaced decisions as superseded and link their successors.

Update ADRs through pull requests. After pushing, link the repository file from Linear with a short summary. Use a commit permalink for the recorded version; this register provides navigation to current files. A pushed branch can be linked while awaiting review, with that state stated explicitly. Update Linear when a decision's status changes, without copying its full text.
