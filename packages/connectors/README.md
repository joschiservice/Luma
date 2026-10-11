# Provider integrations

Low-level provider protocol packages. They take credentials and transports explicitly, never read environment variables and hold no tenant data.

| Package                   | Public exports     | Owns                                                                                                                     |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `@luma/connector-shopify` | root, `/schemas`   | Admin GraphQL transport, provider schemas, OAuth token exchange and refresh, callback and webhook signature verification |
| `@luma/connector-jtl`     | root, `/schemas`   | Cloud and on-premise transport, provider schemas, shipping-method response validation                                    |
| `@luma/connector-cin7`    | root, `/schemas`   | Cin7 Core v2 read transport, per-application request pacing, provider schemas                                            |
| `@luma/connector-gmail`   | root               | Gmail API v1 transport and quota pacing, Google OAuth requests, mailbox query building, MIME parsing and composition     |
| `@luma/connector-core`    | root, `/transport` | Shared failure types and `ConnectorError`; response parsing and retry helpers                                            |

Shopify resolves the access token on each request. The JTL transport accepts either cloud credentials or a trusted on-premise API root; the API must approve an on-premise destination before constructing a client. Provider failures share `ConnectorError` across protocol and application adapters.

[The connections package](../connections/README.md) owns permissions, encrypted credentials, shared capability validation and observation storage. [Workspace apps](../../docs/apps.md) own provider adapters, OAuth state, account binding, normalization and setup UI; provider adapter tests and contract fixtures live there.

Exports point to compiled `dist` output, so consumers see protocol changes only after a build or the package's `dev` watch.
