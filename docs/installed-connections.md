# Installed connections

`createInstalledConnections` in connectors composition provides tenant-scoped setup, health checks, credential rotation and disconnection for Shopify, JTL Cloud and JTL-Wawi on-premise. `ConnectionManagement` is the public management interface. `createInstalledRuntime` connects these installations to the existing capability reader. HTTP commands and setup screens consume these services through LUMA-32 and LUMA-34.

## Setup and access

Apply migration `0004_connector_installations.sql` using the existing migration runner. Grant the runtime database login `luma_connectors`. Use a restricted login; the tables enforce tenant RLS even when a query omits its tenant predicate. Lifecycle events are append-only and commit in the same transaction as each change.

Compose the service with a tenant database, `identity.refreshContext`, an encryption keyring and a trusted `verify` implementation. Every operation refreshes membership. Owners and admins can install, check, rotate and disconnect. Members can list connections and use permitted reads. The credential port is only for trusted adapters and must never be returned by an HTTP route.

Install accepts a label, provider target, requested capabilities and credentials. Shopify targets use a lowercase `*.myshopify.com` hostname. JTL Cloud targets use the provider tenant UUID. JTL on-premise targets use an HTTPS API root with a trailing slash, app ID and app version; their encrypted credentials also contain the challenge code. Target identity is immutable. Create a new installation when changing the account or endpoint.

## Verification and permissions

New installations start `pending`. `check` calls the injected verifier with the bound account and decrypted credentials. The verifier must authenticate with the provider, confirm the expected account and return only provider-confirmed capabilities. It must enforce the deployment network allowlist before contacting a JTL endpoint. Do not implement it by echoing requested permissions or accepting client-supplied grant claims. Acquisition of Shopify OAuth tokens and JTL registration credentials remains in the installation host.

An installation becomes `active` only when every requested capability is granted. Missing grants or verification errors produce `degraded`; raw provider errors are discarded. A successful later check restores access. JTL shipping-method correction is the only supported installed write capability; it requires the matching authoritative read permission.

`createInstalledRuntime` requires observation persistence, capability evidence recording and a JTL endpoint approval callback and `jtlEndpoints` from the same configuration used for verification. Every on-premise request uses these tenant-specific IP pins with TLS hostname validation, including pagination and authorized PATCH requests. Missing or removed approval denies the request. The callback runs before each credential read; a custom `fetch` applies only to Shopify and JTL Cloud. The runtime advertises only the intersection of requested and verified capabilities. It resolves current membership, status and permission before dispatch and before each credential read, including paginated provider requests. Permission removal at the provider also remains enforced by provider responses.

## Rotation and removal

Mutations require the last returned `version`. Concurrent or stale changes return a conflict. Credential rotation atomically replaces the ciphertext, increments `credentialVersion`, clears grants and returns to `pending`. Call `check` to activate the replacement. An in-flight verification cannot overwrite a newer rotation or revocation. A paginated request stops if credentials change during the request; callers must start a fresh read.

Disconnect and revoke erase the local ciphertext and deny further use. They do not revoke the provider's token remotely or cancel a request already sent. Revoke the token with the provider when removing its authorization there. A disconnected or revoked record cannot be reactivated; install a new connection.

## Secrets and key management

Supply 32-byte AES keys from the deployment secret manager, with an active key ID and a map of readable key IDs. No key is stored in PostgreSQL or accepted through connection setup. AES-256-GCM uses a fresh 12-byte nonce and authenticates tenant, connection, target and credential version. Moving ciphertext to another binding fails authentication. Tokens and challenge codes are excluded from connection summaries and lifecycle events.

To rotate an encryption key, deploy the new active key while retaining the old readable key. Re-submit each connection's credentials through `rotate` and verify them. Remove an old key only after no live ciphertext or required backup depends on it. Credential deletion does not erase historical database backups; apply the deployment's encrypted backup retention policy.

## Validation

`connections.test.ts` covers lifecycle transitions, fresh roles, tenant isolation, grants, stale verification, ciphertext tampering and runtime revocation. `connections.integration.test.ts` runs against PostgreSQL with restricted credentials and tests RLS, persistence, concurrent rotation, append-only events and transactional rollback. Run `TEST_DATABASE_URL=... pnpm check` and `pnpm test:e2e` against disposable PostgreSQL 17. Provider credentials are not required by these tests.

JTL shipping-method correction requires both `orders.shipping-method.read` and `orders.shipping-method.write` in requested and verified permissions. The verifier must confirm `salesorders.read`, `salesorders.write`, endpoint availability and provider idempotency support. Shopify installations reject these permissions. Existing read-only connections remain read-only. See [JTL shipping-method correction](jtl.md#shipping-method-correction) for activation and execution requirements.

## Operator interface and HTTP boundary

The workspace Connections page lists installed connections separately from setup options. Owners and admins can submit Shopify tokens, JTL Cloud tokens, or JTL-Wawi registration tokens and challenge codes. Token acquisition remains with the installation host. Members can view connection summaries. Replacement clears permissions until validation succeeds; disconnected records require a new installation.

The shared `apiContract.connections` exposes list/install at `/v1/organizations/:organizationId/connections` and versioned `check`, `credentials`, and `disconnect` commands under `/:connectionId`. Handlers reuse `ConnectionManagement`, refresh membership through that service, and serialize only the public summary schema. Credential fields are never returned. Errors use controlled messages. The web form keeps secrets out of URL state, persistence and the Query mutation cache, clears them after requests, and requires a list refresh after an uncertain result before resubmission.

The API CLI initializes connections when `CONNECTIONS_ACTIVE_KEY_ID` and `CONNECTIONS_KEYS` are configured. `CONNECTIONS_KEYS` is a JSON object mapping key IDs to canonical base64-encoded 32-byte AES keys. Keep old keys in the map until their ciphertext is no longer needed. The runtime uses `IDENTITY_DATABASE_URL`; grant that restricted login `luma_connectors`. Readiness checks the role and table access. Missing key configuration returns `503 SERVICE_UNAVAILABLE`; malformed configuration prevents startup.

`pnpm dev` grants the role and creates a persistent, private `.luma/connection-key` for both new and existing worktrees. Restart `pnpm dev` after this upgrade. Preserve this key with the local database; deleting it makes stored credentials unreadable. Production must inject a persistent keyring through its secret manager.

Shopify verification checks `shop.myshopifyDomain` and `currentAppInstallation.accessScopes` through the authenticated Admin API. It maps provider-confirmed read/write scopes to supported read capabilities. See [Shopify access scopes](https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes).

JTL verification sends authenticated, one-item reads to the bound tenant's sales orders, items and delivery notes endpoints. Denied capabilities remain ungranted; authentication errors and malformed responses fail verification. The checks use the [ERP 2.2 contract](https://developer.jtl-software.com/openapi/erp/2.2.json). They never change provider data. Shipping-method capabilities remain ungranted by the default verifier: read probes cannot prove write access or installation-specific idempotency support. An installation requesting those capabilities remains degraded. Activation requires a custom verifier backed by confirmed grants and a sandbox smoke test.

For JTL on-premise, set `JTL_ALLOWED_ENDPOINTS` to a JSON array of `{ "tenantId": "<Luma organization UUID>", "baseUrl": "https://erp.example.com/api/company/", "addresses": ["10.0.0.5"] }`. Approval matches both organization and exact API root. Requests connect only to the configured IPs, retain TLS certificate and hostname validation, reject redirects, and have a timeout and response-size limit. Update the pins when the destination changes. An empty array denies all on-premise destinations. Cloud requests use the fixed JTL host and the installation's `X-Tenant-ID`.

Custom hosts can still supply `connections` to `buildApp`, or a factory as the fifth argument to `buildRuntimeApp`. That factory receives the identity service. `e2e/connections-server.mjs` uses a deterministic test verifier; production must use provider-confirmed permissions.

The current service returns lifecycle status and verified grants, but no validation reason, last observation or freshness timestamp. The page does not derive observation health from `updatedAt`, and offers troubleshooting for degraded connections without claiming a specific credential or permission failure. Permitted capabilities are the requested/verified intersection on active connections only.

`pnpm test:browser` includes setup for all three targets, invalid credentials, replacement, disconnect confirmation, role denial, stale-version conflicts and unavailable-service recovery. Browser tests need the PostgreSQL setup described in the root README. The component tests cover all lifecycle statuses, read-only/write access and member visibility.
