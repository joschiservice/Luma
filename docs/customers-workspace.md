# Customers workspace

Customers is available in workspace navigation (`G`, then `U`). Installed apps
contribute a `customers` UI slot; Shopify provides the first source. The order
source panel links directly to its customer using Shopify's customer relation.
Each identity is a connection plus a source customer ID. Names and email
addresses never establish a canonical identity or merge records across stores.
Multiple search matches remain visible for operator selection.

Shopify reads customers, contact fields and order history live through the
installation-gated `records` operation. Lists and order history use 20-row cursor
pages. Search text is sent in the request body, quoted as literal provider search
text, and never stored in a URL or browser storage. Order search follows the
order's customer relation. Guest orders without that relation produce no match.

Basic customer context requires `SHOPIFY_PROTECTED_CUSTOMER_DATA_APPROVED=true`
and a current `read_customers` grant. Names, email, phone and name/email search
also require `SHOPIFY_CUSTOMER_CONTACT_APPROVED=true`. Set the latter only after
Shopify approves all three contact fields for the deployment. Actual provider
denials still withhold the affected section. Order search/history also require
`read_orders`; older history needs `read_all_orders`. Returns and fulfillment
retain their own scope checks. Missing access is distinct from empty history.

Select a customer order to inspect fulfillment, returns and refunds. The host
resolves its exact source identity through `GET /v1/organizations/:organizationId/record-source`.
An unambiguous canonical order supplies the existing Orders read model's open
issues and Luma activity. No mapping or an ambiguous mapping is stated explicitly.
The order link opens the full evidence and workflow history.

Protected reads have no client cache and use non-cacheable POST responses. Source,
customer, workspace and authenticated session changes unmount the old view;
refresh clears its content before reading again. Superseded responses are ignored.
Window focus refreshes live records to recheck access.

Entry points: `apps/web/src/features/customers`, the Shopify `web/customers.tsx`
and `infrastructure/customer-records.ts`, and the shared source resolver in
`packages/read-models/src/infrastructure/record-explorer.ts`.

Validation: Shopify record/service tests, `Customers/Workspace` stories, and
`pnpm test:browser customers.browser.mjs`. The browser journey uses deterministic
Shopify responses with real authentication, tenant isolation, source mappings and
canonical order reads. Adapter tests validate emitted queries against Shopify's
2026-07 schema and verify scope and contact denial handling.
