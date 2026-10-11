# @luma/connector-gmail

Gmail API v1 transport, Google OAuth token exchange and refresh, mailbox query building, and MIME parsing and composition.

Credentials and transport are supplied explicitly; the client resolves the access token for each request and paces requests against Gmail's per-user quota. Connection lifecycle, tenant permissions and encrypted storage belong to connections; normalization into capabilities belongs to `@luma/app-gmail`. Exports point to compiled `dist` output.

## Public entry points

- `@luma/connector-gmail`

## Further reading

- [Gmail](../../../docs/gmail.md)
- [Package boundaries and runtime composition](../../../docs/architecture/005-domain-packages-and-runtimes.md)
