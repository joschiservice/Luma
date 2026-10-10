# Installed connections

An installed connection binds a workspace to one provider account (a Shopify shop, a JTL
Cloud tenant, a JTL-Wawi on-premise API or a Cin7 Core account) with encrypted credentials and verified
permissions. Capabilities are usable only while the connection is active and the
provider has confirmed them, and every credential read rechecks tenant membership,
installation and status. Code: `@luma/connections`; provider verification and setup live
in the workspace apps ([apps](apps.md)).

## Access

People with `connections.manage` install, check, rotate and disconnect connections.
Every member can list connection summaries and use permitted reads. Every operation
refreshes membership. Tables enforce tenant RLS even when a query omits its tenant
predicate; use a restricted login inheriting `luma_connectors`. Lifecycle events are
append-only and commit with each change.

The credential port is for trusted adapters only and must never be returned by an HTTP
route. Credential fields are never serialized; errors use controlled messages. The web
form keeps secrets out of URL state, persistence and the query cache, clears them after
each request, and requires a list refresh after an uncertain result before resubmission.

Target identity is immutable; create a new installation to change account or endpoint.
Shopify targets are a lowercase `*.myshopify.com` hostname, JTL Cloud targets the provider
tenant UUID, JTL on-premise targets an HTTPS API root with trailing slash, app ID and
app version (the challenge code is stored with the encrypted credentials), and Cin7 Core
targets the account ID (the API application key is the credential). Shopify
connections are normally created through [OAuth](shopify.md#authorization-and-recovery-guarantees);
manual token setup remains for internal fixtures and deployments without OAuth.

## Verification and permissions

New installations start `pending`. `check` calls the app's verifier with the bound
account and decrypted credentials. The verifier must authenticate, confirm the expected
account and return only provider-confirmed capabilities; never echo requested
permissions or accept client-supplied grant claims. It must enforce the JTL endpoint
allowlist before contacting an on-premise endpoint.

- **Active** requires every requested capability to be granted. Missing grants or
  verification errors produce **degraded**; raw provider errors are discarded. A later
  successful check restores access.
- The runtime advertises only the intersection of requested and verified capabilities,
  and only on active connections. It resolves current membership, status and permission
  before dispatch and before each credential read, including within paginated requests.
  Permission removal at the provider is also enforced by provider responses.
- Summaries carry lifecycle status and verified grants, but no validation reason or
  freshness timestamp. The UI must not derive observation health from `updatedAt` or name
  a specific credential or permission failure for a degraded connection.

Write capabilities need their matching read permission and provider-confirmed write
grants:

- **JTL shipping-method correction** (`orders.shipping-method.read` and `.write`) needs
  confirmed `salesorders.read`, `salesorders.write`, endpoint availability and
  idempotency support. Read probes cannot prove these, so the default verifier grants them
  only to simulated installations; a live installation requesting them stays degraded
  until a custom verifier backed by confirmed grants and a sandbox smoke test exists.
  Shopify installations reject these permissions. See [JTL](jtl.md#shipping-method-correction).
- **JTL purchase-order submission** is likewise granted only to simulated installations
  (see [JTL](jtl.md#purchase-orders)).
- **Shopify fulfillment recovery and inventory corrections** need the corresponding
  Shopify write scopes; see [Shopify actions](shopify-actions.md).

Existing read-only connections stay read-only until they are reauthorized with the new
permissions.

## Rotation and removal

Mutations require the last returned `version`; concurrent or stale changes conflict.
Rotation atomically replaces the ciphertext, increments `credentialVersion`, clears grants
and returns to `pending`; call `check` to activate the replacement. An in-flight
verification cannot overwrite a newer rotation or revocation. A paginated request stops
if credentials change during it; callers start a fresh read.

Disconnect and revoke erase the local ciphertext and deny further use. They do not revoke
the provider's token remotely or cancel a request already sent; revoke the token with the
provider when removing authorization there. A disconnected or revoked record cannot be
reactivated through `check`; install a new connection (Shopify reconnect reuses the
connection ID, see [Shopify](shopify.md#authorization-and-recovery-guarantees)).

## Secrets and key management

The keyring comes from the deployment secret manager: `CONNECTIONS_ACTIVE_KEY_ID` and
`CONNECTIONS_KEYS`, a JSON object mapping key IDs to base64-encoded 32-byte AES keys. No
key is stored in PostgreSQL or accepted through setup. Missing key configuration makes
connection routes return `503 SERVICE_UNAVAILABLE`; malformed configuration prevents
startup. AES-256-GCM uses a fresh nonce and authenticates tenant, connection, target and
credential version, so ciphertext moved to another binding fails authentication. Tokens
and challenge codes never appear in summaries or lifecycle events.

To rotate an encryption key, deploy the new active key while keeping the old key
readable, re-submit each connection's credentials through rotation and verify them.
Remove the old key only when no live ciphertext or required backup depends on it.
Credential deletion does not erase database backups; apply the deployment's encrypted
backup retention policy.

Locally, `pnpm dev` creates a persistent private key at `.luma/connection-key`. Keep it
with the local database; deleting it makes stored credentials unreadable.

## JTL on-premise endpoints

Set `JTL_ALLOWED_ENDPOINTS` to a JSON array of
`{ "tenantId": "<Luma organization UUID>", "baseUrl": "https://erp.example.com/api/company/", "addresses": ["10.0.0.5"] }`.
Approval matches both organization and exact API root. Every on-premise request,
including pagination and authorized writes, connects only to the pinned IPs, keeps TLS
certificate and hostname validation, rejects redirects and has a timeout and
response-size limit. The approval check runs before each credential read; a missing or
removed approval denies the request, and an empty array denies all on-premise
destinations. Update the pins when the destination changes. Cloud requests use the fixed
JTL host and the installation's `X-Tenant-ID`.
