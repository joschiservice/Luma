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

Views store format 2: a list page's state (built-in view, conditions, sorting, grouping, layout
and columns) with field IDs from the list catalog, plus metrics, charts and optional governed
action references. The API still accepts format 1 and upgrades it before validation. Views and
revisions stored in format 1 are upgraded when read, so responses always use format 2. The
upgrade keeps filters and columns without a catalog equivalent under their old names, so such a
view needs repair instead of silently matching more records.

Saving checks conditions, sorting and grouping against the list catalog and the reader's current
permissions. A reference to an unknown, unreadable or archived field needs repair: the save or
preview is refused with 422, or 403 when the role cannot use the field. Unknown and archived
columns are kept and shown as unavailable. Because previews run in the view engine, a view may
also filter with exactly one `any_of` value on a field the record owner's list parameters
express exactly, and group by any column the engine reads.

A preview compiles the view in one place. Lists whose API takes `where` (orders, products,
inventory, fulfillment, returns, customers and purchase orders) run catalog conditions
natively, with built-in views as their owner's view parameter (`stage` for purchase orders).
Other lists run only conditions their owner parameters express exactly and refuse the rest with
422 until their list APIs support them. Drafting describes to the model only the built-in views,
columns, conditions and sorts the engine runs for each list. Custom field conditions become engine predicates, and rows are
keyed by catalog column IDs. Lists without a view reader can save views but cannot preview them.
Metrics, charts and actions run only in the engine, so a view using them must compile when saved.

Private views are visible only to their owner. Workspace
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
