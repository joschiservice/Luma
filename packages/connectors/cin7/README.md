# @luma/connector-cin7

Cin7 Core (formerly DEAR Inventory) API v2 protocol client, request pacing and response schemas.

The account ID and API application key are supplied explicitly; the key is resolved on every request. Cin7 allows 60 calls per minute per API application, so clients of one connection share a request pacer. Installation permissions and credential storage belong to connections; normalization belongs to `@luma/app-cin7`. Exports point to compiled `dist` output.

## Public entry points

- `@luma/connector-cin7`
- `@luma/connector-cin7/schemas`

## Further reading

- [Cin7](../../../docs/cin7.md)
- [Package boundaries and runtime composition](../../../docs/architecture/005-domain-packages-and-runtimes.md)
