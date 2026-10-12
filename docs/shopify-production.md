# Shopify partner readiness

Luma uses one Luma-owned, non-embedded public Shopify app with standalone OAuth for
unrelated merchants; each shop gets its own installation and token pair. Merchants never
create an app or paste credentials. Code is shared across environments, but app
credentials, redirect URLs, databases, encryption keys and installations are separate per
environment. This guide covers app configuration, the external approvals Shopify gates,
privacy request handling and the pre-launch smoke test.

## App configuration

Configure each environment's app with these values (replace placeholders; secrets never
belong in this file). The scopes must match what the server requests; check the OAuth
scope list in `@luma/app-shopify` when changing them.

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

- The redirect URL must match exactly. In development, the app URL is the running tunnel.
- Add `read_customers` only after enabling the protected-data selection (development) or
  receiving production approval, and `read_all_orders` only after Shopify grants it.
- Publish the configuration version after changing URLs or scopes. Existing connections
  must reconnect to receive new scopes or subscriptions; until then they keep their
  current access (read-only connections cannot run [Shopify actions](shopify-actions.md)).
- Change subscriptions are registered per connection during authorization (see
  [commerce sync](commerce-sync.md#change-notifications)).

Server settings: `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_APP_ENVIRONMENT`,
`SHOPIFY_CALLBACK_URL` and `SHOPIFY_WEB_ORIGIN`, kept in the deployment secret manager
with a stable public HTTPS origin. Keep the web origin and callback origin identical so
the signed-in session survives the redirect.

Approval flags request access; they cannot grant it, and the record reader checks actual
grants on every request. All default to false. Restart the server and reconnect after
changing one.

| Flag                                       | Set only after Shopify approves                                    |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `SHOPIFY_PROTECTED_CUSTOMER_DATA_APPROVED` | Protected customer data (requests `read_customers`)                |
| `SHOPIFY_CUSTOMER_CONTACT_APPROVED`        | Name, email and phone access                                       |
| `SHOPIFY_CUSTOMER_ADDRESS_APPROVED`        | Address access; data sync then imports default and order addresses |
| `SHOPIFY_ALL_ORDERS_APPROVED`              | Older-order access (requests `read_all_orders`)                    |

Without contact approval, Customers shows source identities and their imported orders, and
imported profiles and live reads withhold names, email addresses and phone numbers.

## External approvals

Shopify gives no guaranteed approval date; treat review, possible resubmission and
permission approval as onboarding lead time, and do not promise a merchant date until
approval and deployed-store validation pass.

- **Protected customer data:** Partner Dashboard → Apps → app → API access requests →
  Protected customer data access. Select the data, explain the use and save.
  Development-store testing needs no review; production does. Suggested rationale: "Luma
  reads order, payment, fulfillment and customer purchase context to investigate merchant
  operational exceptions." Privacy webhook requests can contain email or phone
  identifiers; describe their encrypted, restricted processing in the data-protection
  details.
- **Older orders:** Partner Dashboard → Apps → app → API access → Read all orders scope →
  Request access. Suggested rationale: "Merchants need to investigate unresolved orders,
  returns and fulfillment discrepancies older than 60 days and reconcile historical
  operational records." Granting the scope does not backfill: data sync reports that
  older orders are available and an operator re-imports order history.
- **Public distribution:** select public distribution before requesting protected data,
  and complete the listing, support and privacy URLs, review credentials, installation
  instructions and data-protection details before submitting for review.

## Privacy operations

The privacy endpoint durably stores encrypted `customers/data_request`,
`customers/redact` and `shop/redact` requests app-wide, including after uninstall or
workspace removal. An invalid HMAC returns 401. A 204 means the request was committed, not
that export or deletion is complete. Retries of the same signed body and topic are
deduplicated, including after completion. No body, shop or customer identifier is logged.
The runtime role can insert requests but cannot read or complete them.

Imported customer profiles are erased automatically on intake (see
[commerce sync](commerce-sync.md#customers)). Everything else is an operator procedure;
the endpoint alone does not make a deployment compliant.

Assign an operator before production onboarding. Check the queue daily and alert on
requests approaching their 30-day deadline. Use a restricted operator session with
database-owner or BYPASSRLS access, never the API runtime credentials. Supply
`SHOPIFY_PRIVACY_DATABASE_URL` and the encryption key settings through the secret manager,
and build `@luma/connections` first.

```sh
node tooling/shopify/privacy.mjs list <environment:clientId>
node tooling/shopify/privacy.mjs export <environment:clientId> <event-key> /private/request.json
node tooling/shopify/privacy.mjs complete <environment:clientId> <event-key> <restricted-evidence-reference>
```

Export creates a new mode-0600 file and never prints the decrypted request. Completion is
an operator attestation: it removes the encrypted request and keeps only topic,
timestamps, event digest and the evidence reference. Never complete a request merely
because the webhook arrived.

For each request:

1. Resolve the authenticated app and shop against the installation bindings in the
   operator session, including prior connection history for that installation. Never
   select a tenant from customer-supplied data.
2. `customers/data_request`: locate the customer and order IDs in retained observations
   and mappings, order snapshots and projections, raw evidence, workflow and issue
   evidence, logs and exports. Live customer-context reads are not persisted. Deliver the
   retained data, or a documented no-data result, to the verified merchant through a
   secure channel.
3. `customers/redact`: remove or anonymize the corresponding retained data across those
   stores. Pause ingestion while doing so, and make sure replay and backups cannot restore
   erased data. Keep only documented legal retention.
4. `shop/redact`: stop the installation's ingestion and erase its secrets and all
   retained shop data, including derived evidence and exports. Check current installation
   status before acting on a delayed request after reinstall; never delete another
   tenant's data or a newer installation's data.
5. Record affected stores, actions, backup expiry or legal retention, verification,
   merchant delivery and the operator in restricted evidence. Remove the temporary files,
   then record completion.

## Smoke test

Run before onboarding a production merchant, through the public origin with the API and
tunnel running, first on the development store `luma-dev-store-1dmrgwsn.myshopify.com` and
then with the approved production app and a real merchant store. A development-store pass
is not evidence of production access approval. Record app ID and version, store, date,
deployed commit and results, without tokens.

- As a workspace owner or admin, install Shopify and connect the store. Confirm consent,
  callback and an active connection.
- Cancel consent, retry and reconnect. The connection ID stays the same without
  duplicates; a replayed callback fails.
- Read a known order, product, stock level and fulfillment and compare IDs and quantities
  with Shopify. Check customer context and an older order with and without their grants:
  denied access shows a coverage warning, not an empty successful section. Confirm data
  sync imports separately.
- Change granted scopes, confirm webhook delivery and degraded health, reconnect and
  confirm recovery. Replay a scope event; current grants must prevail over its payload.
- Uninstall in Shopify and confirm webhook delivery, revoked health and erased tokens.
  Reinstall and reconnect; a delayed uninstall must not revoke the new credentials.
- Send all three compliance topics, check durable pending receipts, retry one, confirm a
  bad HMAC gets 401 and rehearse export and redaction completion. A CLI trigger tests the
  endpoint, not the deployed subscription; also inspect delivery evidence in Shopify.

References: [standalone authentication](https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps),
[access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens),
[app distribution](https://shopify.dev/docs/apps/launch/distribution),
[protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data),
[orders permissions](https://shopify.dev/docs/api/usage/access-scopes#orders-permissions),
[privacy webhooks](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance).

## Delivery validation evidence

Simulator runs exercise registration, signed durable intake, deduplication and refresh
scheduling through the real services. They do not prove Shopify delivers to a deployed
HTTPS endpoint. Keep development-store delivery evidence separate from simulator results.

On the development store, reconnect and inspect Change subscriptions. Change an order's
payment, edit an order, update stock, disconnect a test stock level, edit a location and
apply or release a fulfillment hold. Include customer changes only with approved access.
Check each applicable topic's last verified delivery, the resulting sync run and fresh
provider observations. Repeat a delivery and reconnect to check deduplication and
subscription repair. Stop the tunnel and verify scheduled reconciliation still recovers
changes, then restore it. For deleted synthetic orders and products, confirm the subsequent
point lookup and source retirement; the signed payload alone must not retire anything.
Record the deployed commit, app version, actual grants, topic, Shopify event ID, delivery
and refresh times and result in restricted rollout evidence, excluding payloads and tokens.
