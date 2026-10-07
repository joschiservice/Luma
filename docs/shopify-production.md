# Shopify partner readiness

Luma uses a standalone OAuth app. Merchants authorize in Shopify; they do not
create an app or paste credentials. Development and production must use separate
app credentials, databases and encryption keys.

## Developer portal settings

Use the development store `luma-dev-store-1dmrgwsn.myshopify.com` for synthetic
smoke tests. There is no production deployment or approved public app yet.

| Setting                    | Value                                                                                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Distribution               | Public distribution for unrelated merchants; select before requesting protected data                                                                                                                                                               |
| Embedded app               | Off                                                                                                                                                                                                                                                |
| App URL                    | The public HTTPS Luma web origin (development: the running tunnel)                                                                                                                                                                                 |
| Allowed redirection URL    | `https://<luma-host>/api/v1/shopify/callback` (exact match)                                                                                                                                                                                        |
| Installation               | Authorization-code grant; `use_legacy_install_flow = true`                                                                                                                                                                                         |
| API and webhook version    | `2026-07`                                                                                                                                                                                                                                          |
| Required scopes            | `read_orders,read_products,read_inventory,write_inventory,read_merchant_managed_fulfillment_orders,read_third_party_fulfillment_orders,read_returns,read_locations,write_merchant_managed_fulfillment_orders,write_third_party_fulfillment_orders` |
| Customer scope             | Add `read_customers` after enabling the protected-data selection for development or receiving production approval                                                                                                                                  |
| Historical scope           | Add `read_all_orders` only after Shopify grants this scope                                                                                                                                                                                         |
| Compliance topics          | `customers/data_request`, `customers/redact`, `shop/redact`                                                                                                                                                                                        |
| Compliance URL (all three) | `https://<luma-host>/api/v1/shopify/privacy`                                                                                                                                                                                                       |

Fulfillment recovery requires the fulfillment write scopes. Existing read-only
connections keep their read access and must reconnect to enable recovery.
Inventory corrections require `write_inventory` and a separate approval. See
[Shopify inventory corrections](shopify-inventory-corrections.md).

Publish the configuration version after changing URLs or scopes. The server
registers connection-specific `app/uninstalled` and `app/scopes_update`
subscriptions during authorization, plus order, fulfillment, product,
inventory-level and (when approved) customer change notifications at
`/api/v1/shopify/changes/:organizationId/:connectionId`. Change subscriptions are
best effort; scheduled reads still cover their records. Existing connections must reconnect once
to install the new scope-change subscription.

Example configuration (replace placeholders; no secrets belong in this file):

```toml
client_id = "<app-client-id>"
name = "Luma"
application_url = "https://<luma-host>"
embedded = false

[access_scopes]
scopes = "read_orders,read_products,read_inventory,write_inventory,read_merchant_managed_fulfillment_orders,read_third_party_fulfillment_orders,read_returns,read_locations,write_merchant_managed_fulfillment_orders,write_third_party_fulfillment_orders"
use_legacy_install_flow = true

[auth]
redirect_urls = ["https://<luma-host>/api/v1/shopify/callback"]

[webhooks]
api_version = "2026-07"

[[webhooks.subscriptions]]
compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]
uri = "/api/v1/shopify/privacy"
```

Set `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_APP_ENVIRONMENT`,
`SHOPIFY_CALLBACK_URL`, and `SHOPIFY_WEB_ORIGIN` on the server. Keep the web origin
and callback origin identical so the signed-in session survives the redirect.
Set `SHOPIFY_PROTECTED_CUSTOMER_DATA_APPROVED=true` only after the development
selection or production approval; set `SHOPIFY_ALL_ORDERS_APPROVED=true` only
when Shopify grants older-order access. Both default to false. Restart the
server and reconnect after changing either flag. These flags request access;
they cannot grant it. The record reader checks actual grants for each request.

Set `SHOPIFY_CUSTOMER_CONTACT_APPROVED=true` only after Shopify also approves
name, email and phone access for this deployment. Set
`SHOPIFY_CUSTOMER_ADDRESS_APPROVED=true` only after Shopify approves address access;
Data sync then imports default addresses with customer profiles. It defaults to false. Without
it, Customers shows source identities and authorized order history, and withholds
contact fields and name/email search. Restart after changing this flag.

## External approvals

| Approval                | Where to request it                                                                   | Current state / effect                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protected customer data | Partner Dashboard → Apps → app → API access requests → Protected customer data access | Not confirmed. Select protected customer data, explain the use, and save. Development-store-only testing does not require submission for review. Production requires review. |
| Older orders            | Partner Dashboard → Apps → app → API access → Read all orders scope → Request access  | Not confirmed. Explain historical operational reconciliation. Without approval and a merchant grant, coverage is normally 60 days.                                           |
| Public app              | Public distribution / app review submission                                           | Not submitted. Complete listing, support/privacy URLs, review credentials, installation instructions and data-protection details before submission.                          |

Suggested protected-data rationale: “Luma reads order, payment, fulfillment and
customer purchase context to investigate merchant operational exceptions. It
does not request customer names, addresses, email or phone in commerce reads.”
Privacy webhook requests can themselves contain email or phone identifiers;
include their encrypted, restricted processing in the data-protection details.

Suggested older-order rationale: “Merchants need to investigate unresolved
orders, returns and fulfillment discrepancies older than 60 days and reconcile
historical operational records.” Granting the scope alone does not backfill
records: Data sync reports that older orders are available and an operator
re-imports order history (see [Commerce sync](commerce-sync.md)). LUMA-104 supplies
live operational record reads.

Shopify does not give a guaranteed approval date in the linked guides. Treat
review, possible resubmission and permission approval as external onboarding
lead time. Record submission date, response and approval evidence on LUMA-115;
do not promise a partner date until approval and deployed-store validation pass.

## Privacy operations

Migration `0038_shopify_privacy_requests.sql` provides app-wide durable intake,
including after uninstall or workspace removal. Invalid HMAC returns 401. A 204
means the encrypted request was committed, not that deletion/export is complete.
Retries of the same signed body and topic are deduplicated, including after
completion. No body, shop or customer identifiers are written to logs. The
runtime database role can insert but cannot read or complete requests.

Assign an operator before production onboarding. Check the queue daily and alert
on pending requests approaching their 30-day deadline. Use a restricted operator
session with database-owner/BYPASSRLS access, never the API runtime credentials.
Supply `SHOPIFY_PRIVACY_DATABASE_URL` and the deployment encryption key settings
through the secret manager. Build `@luma/connections` first.

```sh
node tooling/shopify/privacy.mjs list <environment:clientId>
node tooling/shopify/privacy.mjs export <environment:clientId> <event-key> /private/request.json
node tooling/shopify/privacy.mjs complete <environment:clientId> <event-key> <restricted-evidence-reference>
```

Export creates a new mode-0600 file and never prints the decrypted request.
Completion is an operator attestation: it removes the encrypted request and
retains only topic, timestamps, event digest and the evidence reference. Do not
complete a request merely because the webhook was received.

For each request:

1. Resolve the authenticated app/shop against `shopify_installation_bindings` in
   the operator database session. Never select a tenant from customer-supplied
   data. Include prior connection history for that installation.
2. For `customers/data_request`, locate the supplied customer/order IDs in retained
   source observations and mappings, order snapshots/projections, raw evidence,
   workflow and issue evidence, logs and exports. Live customer-context reads are
   not persisted by the Shopify record reader. Provide the retained data (or a
   documented no-data result) to the verified merchant through a secure channel.
3. For `customers/redact`, imported customer profiles for the verified shop are
   erased automatically when the request is received and are not imported again;
   `shop/redact` erases all of the shop's imported profiles. Remove or anonymize the
   remaining corresponding retained data
   across those stores. Pause ingestion while doing so and ensure replay/backups
   cannot restore erased data. Preserve only any documented legal retention.
4. For `shop/redact`, stop the installation's ingestion, erase its secrets and
   all retained shop data, including derived evidence and exports. Check current
   installation status before acting on delayed requests after reinstall. Do not
   delete another tenant's data or erase a newer installation solely from an old
   uninstall delivery.
5. Record affected stores, actions, backup expiry or legal retention, verification,
   merchant delivery when applicable, and the operator in restricted evidence.
   Remove the temporary request/export files and then record completion.

Automated cross-domain redaction and secure merchant delivery are not supplied
by the intake command. The operator must perform and verify these actions.
Production readiness requires a rehearsed fulfillment procedure and monitored
ownership; a working webhook alone is insufficient.

## Smoke-test evidence

Run through the public development origin while the API and tunnel are running.
Record app ID/version, store, date, deployed commit and results without tokens.

- Sign in as a workspace owner or admin; install Shopify in Luma; connect the demo
  hostname. Confirm the Shopify consent screen, callback and active connection.
- Cancel consent, retry, and reconnect. Confirm recovery and the same connection
  ID without duplicates. A replayed callback must fail.
- Read a known order, product, stock level and fulfillment; compare IDs and
  quantities with Shopify. Check customer context and an older order with and
  without their grants. Denied access must show a coverage warning, not an empty
  successful section. Confirm LUMA-96 ingestion separately before claiming sync.
- Change granted scopes, confirm actual webhook delivery and degraded health,
  then reconnect and confirm recovery. Replay a scope event and verify current
  grants prevail over its old payload.
- Uninstall in Shopify. Confirm webhook delivery, revoked health and erased
  tokens. Reinstall and reconnect; delayed uninstall must not revoke valid new
  credentials.
- Send all three compliance topics, check durable pending receipts, retry one,
  reject a bad HMAC with 401, and rehearse export/redaction completion. A CLI
  trigger tests the endpoint, not the deployed subscription; inspect actual
  delivery evidence in Shopify as well.

Repeat with an approved production app and real merchant store before closing
LUMA-115. A development-store pass is not evidence of production access approval.

References: [protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data),
[orders permissions](https://shopify.dev/docs/api/usage/access-scopes#orders-permissions),
[privacy webhooks](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance),
[standalone authentication](https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps).
