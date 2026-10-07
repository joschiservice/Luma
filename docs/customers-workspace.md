# Customers workspace

Customers lists the customer profiles that data sync imports for approved deployments (see
[Commerce sync](commerce-sync.md#customers)) and shows live order history from the installed
app. Luma never establishes a canonical customer identity: each identity is a connection
plus a source customer ID, and names or email addresses never merge records across stores,
so same-name customers stay separate rows.

Code: `@luma/customers` owns the profiles; `@luma/read-models` reads them. Reads require
`customers.read`.

## List and search

The list reads imported profiles and every commerce connection with its customer access and
sync state. Search matches name, email and phone anywhere, and the source customer ID
exactly or by its last segment. Lists sort by creation time, order count or name with a
keyset cursor bound to the filters.

Each read scans the tenant's profiles. 50,000 profiles stayed under 100 ms locally; larger
tenants need a maintained search projection like the Orders list.

Search text can contain names and email addresses, so the page keeps it in component state
and never writes it to the URL or browser storage, and API telemetry drops query values
outside its allowlist. Filters, sort and cursors are URL state.

An order's source panel links to its customer by source identity. The list resolves that to
the imported profile and opens it; a customer that has not been imported is stated
explicitly rather than guessed.

## Detail

The detail page shows the imported profile: contact fields and address only when the source
shared them (`Not shared` otherwise), the source's order count, amount spent, account state,
tags, and the source identity with its read time.

Order history comes from the installed app's `customers` UI slot. Shopify reads it live
through its installation-gated `records` operation in 20-row cursor pages. History requires
`read_orders`; older history needs `read_all_orders`. Missing access is shown distinctly from
empty history.

A selected order resolves its exact source identity through the record-source endpoint. An
unambiguous canonical order supplies the Orders read model's open issues and Luma activity.
No mapping or an ambiguous mapping is stated explicitly.

## Access and protected data

- Profiles and live reads need Shopify's protected customer data approval
  (`SHOPIFY_PROTECTED_CUSTOMER_DATA_APPROVED`) and a current `read_customers` grant.
- Names, email addresses and phone numbers also need `SHOPIFY_CUSTOMER_CONTACT_APPROVED`;
  addresses need `SHOPIFY_CUSTOMER_ADDRESS_APPROVED`. See
  [Shopify partner readiness](shopify-production.md).
- Revoking store access withholds live history but not the imported profile, which follows
  the profile retention and erasure rules.
- Live reads have no client cache and use non-cacheable POST responses. Customer, workspace
  and session changes unmount the old view; refresh clears content before reading again,
  superseded responses are ignored, and window focus rereads to recheck access.
