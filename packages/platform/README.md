# @luma/platform

Shared technical infrastructure: tenant database contracts, canonical JSON, observability, performance instrumentation and the model gateway.

Keep business rules in domain packages. Tenant transactions and model routing must preserve tenant isolation and data-region constraints.

## Public entry points

- `@luma/platform`
- `@luma/platform/composition`

## Further reading

- [Tenant isolation and data residency](../../docs/architecture/003-tenant-isolation-and-data-residency.md)
- [Model gateway and Bedrock EU route](../../docs/model-gateway.md)
- [Observability](../../docs/observability.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
