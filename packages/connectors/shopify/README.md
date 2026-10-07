# @luma/connector-shopify

Shopify Admin GraphQL transport, OAuth token exchange and refresh, and callback and webhook signature verification.

Credentials and transport are supplied explicitly; the client resolves the access token for each request. Connection lifecycle, tenant permissions and encrypted storage belong to connections; normalization belongs to `@luma/app-shopify`. Exports point to compiled `dist` output.

## Public entry points

- `@luma/connector-shopify`
- `@luma/connector-shopify/schemas`

## Further reading

- [Shopify](../../../docs/shopify.md)
- [Package boundaries and runtime composition](../../../docs/architecture/005-domain-packages-and-runtimes.md)
