# ADR-014: Adaptive workspaces and operational packages

Status: Accepted. Date: 2026-10-13.

## Context and alternatives

Businesses need common operational queues with different fields, access rules and parameters.
Separate maintained applications would drift from the platform's permissions and execution
controls. Arbitrary generated code or a universal custom database would create another business
logic and authorization surface. Provider apps alone are not a suitable package format: they
own installations, credentials and provider protocols, while these packages assemble existing
platform capabilities.

## Decision

`@luma/adaptive` owns typed field definitions and values, saved query descriptions and operational
package installations. Record owners retain business records and commands. Read adapters use
trusted tenant context and current record permissions. View definitions never contain snapshots,
credentials, executable presentation code or permission grants.

The package format is a versioned definition containing fields, views, workflows, required
capabilities and typed workspace parameters. Published defaults are immutable. Each installation
stores its reviewed parameter values and references to resources it created separately from those
defaults. Local edits belong to the installed resource; a later package version adds new defaults
without replacing existing local field or view choices. Conflicting resource identities refuse the
installation rather than taking over another resource.

Installation reviews additions and missing requirements before changing anything. Owner
operations share a transaction-scoped database for an atomic install. The same package version
and configuration is idempotent. Workflows install inactive; normal reviewed activation controls
execution. Packages never assign permissions to roles. Uninstall archives package resources and
retains values, records, workflow evidence and append-only audit history. Active workflows must
be revoked through their owner before uninstall.

View action bindings contain a supported capability or exact published workflow reference and
typed row input mappings. The owner validates inputs and produces the proposal. Current
permissions, policy, approvals, idempotency and fresh verification remain enforced by that owner.
Each bulk row is an independent command and retains an independent outcome. A model can draft
a constrained view; a person reviews and edits it before saving.

## Consequences and reversal

The schema is intentionally limited to supported records and capabilities. Unsupported queries
must explain their limitation; they cannot pretend a paged sample represents all records.
Tenant-scoped PostHog release flags control rollout independently from authorization.

Distribution, arbitrary export/import and rollback remain separate concerns. Extending the
bounded schema is cheaper than migrating generated code. Removing the package feature archives
its definitions; preserving custom values and view revision history avoids loss of business data.
Evidence comes from tenant-isolation, owner-command and cross-workspace installation journeys.
