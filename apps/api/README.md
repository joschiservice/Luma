# @luma/api

The Luma HTTP API process.

`src/composition/bootstrap.ts` installs instrumentation before loading the application, then `src/index.ts` starts the application-runtime HTTP server. Service assembly belongs to application-runtime, HTTP contracts to api-contract and domain rules to their owning packages. Backend and browser journey tests live in `e2e`; provider schema update scripts live in `scripts`.

## Further reading

- [API](../../docs/api.md)
- [Local development](../../docs/development.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
