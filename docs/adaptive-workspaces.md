# Adaptive workspaces

Adaptive workspaces add typed fields and persistent queries to supported commerce records.
Record owners retain authority over data and actions. Every view is reauthorized when it is
opened, previewed or used for an action; saved definitions never contain a copy of records.

## Fields and authority

Field definitions carry English and German labels and separate read and edit permissions from
the permission catalog. Reading a field also requires the record owner's read permission.
Luma-owned values are typed, revised and audited with the actor and before/after values.
Provider-observed fields cannot be changed through the Luma value editor.

A field's identity and record type remain stable. Type changes and choice removal are refused
while values exist. Archive hides a definition while retaining its values and history. A view
keeps an archived column as unavailable; a filter or ordering that needs an archived field
requires repair before it can run. Product fields attach to the canonical SKU represented by
the Products workspace; source product parents remain provider evidence.

Workflows read scalar values and explicit choice-membership booleans. An unset field returns
`present: false` and a type default. Conditions must check presence before treating the value
as known. Writes use the normal
Action Admission boundary, pinned definition and value revisions, policy review, retry-safe
owner effects and an independent value read. A workflow cannot edit a provider observation.
Workflow value and before-value JSON are limited to 1,000 characters by the existing action parameter contract; direct text edits support
4,000 characters. Larger values require a direct edit rather than a truncated workflow input.

## Saved queries

Views store a versioned record query, display columns, sorting, grouping, charts, metrics and
optional governed action references. Private views are visible only to their owner. Workspace
and role sharing never grant record access. Visible shared views may be revised by their owner
or a view manager; duplication creates a private copy. Revision history retains changes, and
stale revisions are refused.

Native order and custom-field predicates run together in PostgreSQL before pagination. Other
combined operations drain a bounded complete owner query before grouping or aggregation; a
query that exceeds the bound refuses the operation and asks for narrower filters. An aggregate
never claims completeness from a single returned page. Cursors bind the tenant and query.

Natural-language creation proposes an unsaved constrained draft. Unsupported requests and
ambiguous identities require clarification. Model processing follows the existing EU
zero-retention authoring route. Saving requires explicit review, and visual editing uses the
same validated query contract.

## Actions and packages

Action inputs map row fields or typed literals into supported capability commands or exact
published workflow versions. Views cannot supply policy or approval settings. Each selected
record receives its own reviewed change and result. A durable claim precedes dispatch; after
an interruption, uncertainty remains until the record owner reconciles its command. Replaying
a retained command does not dispatch it again.

The supplier follow-up action prepares a draft in the Operations Inbox. Sending, independent
send verification and the next supplier check remain owned by the existing inbox and procurement
services. Mail acceptance is not supplier confirmation.

Operational packages contain definitions and required permissions, never credentials or
customer records. Installation reviews missing capabilities and additions, then applies owner
operations atomically. It does not assign permissions or activate workflows. Workspace
parameters and local resource edits stay separate from package defaults. A later version can
add definitions without replacing local resources. Uninstall archives package additions and
retains values, records, runs and audit history. Active triggers and unfinished workflow runs
must be disabled or completed through their owner before removing a package.

See [ADR-014](architecture/014-adaptive-workspaces.md) for the package format and ownership
decision. Release flags use the server's tenant-scoped PostHog evaluation, independently from
permissions; see [feature flags](observability.md#feature-flags).
