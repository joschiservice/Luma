# Customers workspace

Customers lists the customer profiles that data sync imports from Shopify (for approved
deployments) and from JTL connections set up with customer import (see
[Commerce sync](commerce-sync.md#customers)), and shows each customer's imported orders.
Luma never establishes a canonical customer identity: each identity is a connection plus a
source customer ID, and names or email addresses never merge records across sources, so
same-name customers stay separate rows.

Code: `@luma/customers` owns the profiles; `@luma/read-models` reads them. Reads require
`customers.read`.

## List and search

The list reads imported profiles and every commerce connection with its customer access and
sync state. Search matches name, email and phone anywhere, and the source customer ID
exactly or by its last segment. Lists sort by creation time, order count, name, amount spent,
last source update or last order date, with a keyset cursor bound to the tenant, filters,
conditions, grouping and sort. Profiles without the sorted value come last in both directions.
Amount spent orders by currency, then amount, so amounts compare only within one currency.

### Conditions and grouping

The list accepts conditions and groups from the Customers catalog in `@luma/api-contract`, with
the shared rules for values, dates, groups and cursors described for
[Orders](orders-workspace.md#conditions-and-grouping).

- Conditions never match through details a source withholds. A country is the shared address's
  country as reported, upper-cased (an ISO code or a name, depending on the source); without a
  shared address it is unknown, so it matches neither a country nor `empty`. Contact details
  are not conditions; `contactShared` says whether the source shares them.
- Order count and amount spent are what the source reports; a source that reports none (JTL)
  is empty and matches no comparison. Amounts need a currency.
- Missing means a complete full read no longer found the customer.
- The last order date is the latest placed date among the imported orders that the profile's
  own connection attributes to the customer; orders without a placed date do not count. Data
  sync maintains it with the order links. It needs `orders.read` as well: without it the list
  omits the date, and conditions, groups and sorts on it return 403.
- Groups: state, source, tag, country, and creation and last order dates by day, week or month.
  A customer counts in the group of each tag. Groups sum amounts spent per currency.
- Group counts are `complete: false` while a source still imports its customers.
- Custom customer fields filter as `custom:<field ID>` and sort as `sort=custom:<field ID>`,
  with the rules of [custom order fields](orders-workspace.md#conditions-and-grouping): each
  field must be live (400) and readable by the reader (403), a missing value is empty, and
  multiple-choice fields cannot order rows. They don't group.

Each read scans the tenant's profiles. 50,000 profiles stayed under 100 ms locally; larger
tenants need a maintained search projection like the Orders list. Re-measure with
`LUMA_CUSTOMER_BENCHMARK=<profile count> pnpm test:performance customers`.

Search text can contain names and email addresses, so the page keeps it in page state only:
never in the URL, saved views, remembered list state or browser storage, and paging trails are
keyed without it. API telemetry drops query values outside its allowlist. A link's `q` is
adopted on load and removed with a replace. Views, conditions, sort and cursors are URL state,
and a customer's breadcrumb returns to the list state it was opened from. Links from before
views (`state`, `connectionId` without `customerId`, `sort=amountSpent`) become conditions
and the `spent` sort.

An order's source panel links to its customer by source identity. The list resolves that to
the imported profile and opens it; a customer that has not been imported is stated
explicitly rather than guessed.

## Detail

The detail page shows the imported profile: contact fields and address only when the source
shared them (`Not shared` otherwise), account state, tags, and the source identity with its
read time. Order count and amount spent are shown only when the source reports them; JTL
reports neither.

A customer that a complete full read no longer found keeps its profile and history but is
marked `No longer in <source>` in the list and on the page, with the time it went missing.
Sync removes it after 30 days unless the source reports it again; see
[commerce sync](commerce-sync.md).

Order history is the Orders list filtered by `customerId`, with the same rows, cursor
paging and issue links. It reads Luma's imported orders, never the provider, so it needs no
installed app and survives revoked store access. The filter follows the order links that
sync records for the customer's own connection, resolved through current mappings, so an
order linked across sources appears once under its current canonical ID. Orders the source
does not attribute to a customer, such as guest checkouts, appear in no history.

The filter needs `customers.read` as well as `orders.read`, because which orders a person
placed is customer data; without either it returns 403, which the page shows as missing
access rather than an empty history. It binds the customer's order IDs to the list query,
so a customer with tens of thousands of orders makes each history read proportionally
larger.

## Access and protected data

- Profiles and live reads need Shopify's protected customer data approval
  (`SHOPIFY_PROTECTED_CUSTOMER_DATA_APPROVED`) and a current `read_customers` grant.
- Names, email addresses and phone numbers also need `SHOPIFY_CUSTOMER_CONTACT_APPROVED`;
  addresses need `SHOPIFY_CUSTOMER_ADDRESS_APPROVED`. See
  [Shopify partner readiness](shopify-production.md).
- JTL shares customers only for connections set up with customer import. Contact and
  address fields have no separate approval in JTL.
- Revoking store access does not remove the imported profile or its order history; both
  follow the profile retention and erasure rules. Missing-customer removal only runs while
  customer reads continue, because it needs complete full reads.
