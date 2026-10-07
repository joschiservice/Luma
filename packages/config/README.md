# @luma/config

Parses and validates server configuration: API, identity, connections, commerce sync, model gateway, observability and workflows.

Readers take an explicit environment map and run at process startup; services receive typed settings. Domain code never reads environment variables. Credentials stay on the server. Document new settings in the relevant `.env.example`.

Exports point to compiled `dist` output, so consumers see source changes only after a build or the package's `dev` watch.

## Further reading

- [Local development](../../docs/development.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
