# Provider integrations

| Package                   | Public exports     | Owns                                                                                                                     |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `@luma/connector-shopify` | root, `/schemas`   | Admin GraphQL transport, provider schemas, OAuth token exchange and refresh, callback and webhook signature verification |
| `@luma/connector-jtl`     | root, `/schemas`   | Cloud and on-premise transport, provider schemas, shipping-method response validation                                    |
| `@luma/connector-core`    | root, `/transport` | Shared failure types and error class; response parsing and retry helpers                                                 |

Supply credentials and transports explicitly. The packages do not read environment variables or manage tenant data. Shopify resolves the access token on each request; the JTL transport accepts either cloud credentials or a trusted on-premise API root. The API must approve on-premise destinations before constructing a client.

Luma's API owns connection permissions, encrypted credential storage, OAuth state, app/environment binding, capability input/output validation, snapshot mapping, and webhook refresh scheduling. Provider failures use the same `ConnectorError` class across packages and API adapters, preserving retry and uncertain-write handling.

Each provider has its own manifest, build, typecheck, tests, and explicit package exports. Import through those exports, not another package's source files. Keep tests beside the implementation. Adapter and retained provider-contract fixtures remain with API integration tests because they verify Luma's complete capability behavior.

```sh
pnpm exec turbo run test --filter='@luma/connector-*'
pnpm exec turbo run build --filter='@luma/connector-*'
```

The regular workspace checks include all three packages. Development builds watch their sources; API and worker processes watch their compiled outputs.
