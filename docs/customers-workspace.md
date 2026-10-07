# Customers workspace

Customers is available in workspace navigation (`G`, then `U`). It lists the customer
profiles that data sync imports for approved deployments (see
[Commerce sync](commerce-sync.md#customers)), with the shared collection toolbar,
coverage line, table and pagination used by the other record workspaces. Each identity
is a connection plus a source customer ID. Names and email addresses never establish a
canonical identity or merge records across stores, so same-name customers stay
separate rows.

`GET /v1/organizations/:organizationId/customers` and `/customers/:customerId` require
`customers.read`. The read model is `packages/read-models/src/infrastructure/customers`;
it reads `customer_profiles` (owned by `@luma/customers`) through the case-reader role
and lists commerce connections with their customer access and sync state. Search matches
name, email and phone anywhere, and the source customer ID exactly or by its last
segment. Lists sort by customer creation time, order count or name with a keyset cursor
bound to the filters. Each read scans the tenant's profiles. With 50,000 profiles in local development, list,
sort and search requests took 65–90 ms through the web proxy; larger tenants may need a
search projection like `orders_list`.

Search text can contain names and email addresses. The web page keeps it in component
state and never writes it to the URL; API telemetry filters query values outside its
allowlist. Filters, sort and page cursors are URL state.

The order source panel links to its customer with a source identity
(`customers?connectionId=…&customerId=gid://…`). The list page resolves it to the imported
profile with `externalId` and opens the detail page. A customer that has not been imported
is stated explicitly rather than guessed.

## Customer detail

The detail page shows the imported profile: contact fields and address only when the
source shared them (`Not shared` otherwise), the source's order count, amount spent,
account state and tags, and the source identity with its read time. Order history comes
from the installed app's `customers` UI slot, which Shopify implements in
`packages/apps/shopify/src/web/customers.tsx`. It reads orders live through the
installation-gated `records` operation in 20-row cursor pages. Order history requires
`read_orders`; older history needs `read_all_orders`. Missing access is distinct from
empty history.

Select an order to inspect fulfillment, returns and refunds. The host resolves its exact
source identity through `GET /v1/organizations/:organizationId/record-source`. An
unambiguous canonical order supplies the existing Orders read model's open issues and Luma
activity. No mapping or an ambiguous mapping is stated explicitly.

Live reads have no client cache and use non-cacheable POST responses. Customer, workspace
and session changes unmount the old view; refresh clears its content before reading again,
and superseded responses are ignored. Window focus refreshes live history to recheck
access. Revoking store access withholds live history but not the imported profile, which
follows the profile retention and erasure rules.

Validation: `pnpm test:e2e customers.e2e.mjs` covers search, filters, sorting, cursors,
tenant isolation and the `customers.read` permission. `pnpm test:browser
customers.browser.mjs` follows an order's customer link with real authentication, source
mappings and deterministic Shopify responses. `Customers/Workspace` stories cover list and
detail states in both themes and at narrow widths.
