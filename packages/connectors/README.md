# Provider integrations

| Package                   | Public exports     | Owns                                                                                                                     |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `@luma/connector-shopify` | root, `/schemas`   | Admin GraphQL transport, provider schemas, OAuth token exchange and refresh, callback and webhook signature verification |
| `@luma/connector-jtl`     | root, `/schemas`   | Cloud and on-premise transport, provider schemas, shipping-method response validation                                    |
| `@luma/connector-core`    | root, `/transport` | Shared failure types and error class; response parsing and retry helpers                                                 |

Supply credentials and transports explicitly. The packages do not read environment variables or manage tenant data. Shopify resolves the access token on each request; the JTL transport accepts either cloud credentials or a trusted on-premise API root. The API must approve on-premise destinations before constructing a client.

[The connections package](../connections/README.md) owns permissions, encrypted credentials, shared capability validation, and observation storage. [Workspace apps](../../docs/apps.md) own provider adapters, OAuth state, account binding, normalization, and setup UI. Provider failures share `ConnectorError` across protocol and application adapters.

Import package public exports. Provider adapter tests and contract fixtures are colocated in their app packages. Application-runtime tests cover complete cross-package workflows.

```sh
pnpm exec turbo run test --filter='@luma/connector-*'
pnpm exec turbo run build --filter='@luma/connector-*'
```

The regular workspace checks include all three packages. Provider packages expose compiled outputs; run their development builds when changing protocol clients.
