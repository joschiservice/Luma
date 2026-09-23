# @luma/config

Parses and validates API, identity, connection, model gateway, observability, and workflow configuration.

## Responsibilities

Readers accept an explicit environment map. Parse configuration at process startup and pass typed settings to services. Keep credentials on the server and avoid reading environment variables inside domain code.

## Public entry points

Import through these package exports. Private source paths are not supported across package boundaries.

- `@luma/config` — [source](./src/index.ts).

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm exec turbo run build --filter=@luma/config...
pnpm exec turbo run typecheck --filter=@luma/config
pnpm exec turbo run test --filter=@luma/config
```

## Further reading

- [Engineering guide](../../docs/development.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
