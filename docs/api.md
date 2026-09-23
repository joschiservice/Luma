# HTTP API foundation

One contract is shared by Fastify, the web client and OpenAPI. Follow the [identity setup](identity.md) to configure PostgreSQL and authentication before starting the API.

## Run and consume

Run `pnpm dev`. The API listens on `127.0.0.1:3001`; Vite proxies `/api/*` to it, removing `/api`. The proxy uses the default API address; update its target in `apps/web/vite.config.ts` if changing the local API host/port. Production hosting must provide the same-origin `/api` proxy. Cross-origin browser access is not enabled.

```sh
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:3001/ready
curl 'http://127.0.0.1:3001/v1/connector-providers?category=erp'
curl http://127.0.0.1:3001/v1/connector-providers/shopify
curl http://127.0.0.1:3001/openapi.json
```

`connector-providers` is a public, static sample catalog owned by the connectors module. It describes Shopify/JTL provider names and categories, not installed connections or working integrations. It exposes no tenant data. The application owns the catalog; HTTP handlers only map validated requests and use-case results.

Web consumers use `createWebApiClient()` from `apps/web/src/lib/api-client.ts` and `connectorProviderQueryOptions(client, providerId)` from the feature directory:

```ts
const provider = await queryClient.fetchQuery(
  connectorProviderQueryOptions(createWebApiClient(), 'shopify'),
);
// provider.name and provider.category are inferred from the shared contract.
```

This adapter is tested without adding a sample screen to the product. Browser calls use `/api`; SSR callers pass an absolute API origin. Create credential-bearing clients per request, never as a server singleton. Future session forwarding must be explicit in the server authentication layer. Query cancellation reaches fetch; malformed responses and non-success results do not enter the data cache. Tenant queries must later include the organization ID in their cache keys.

## Contract and versioning

`@luma/api-contract` exports runtime schemas and `apiContract`. `@luma/api-contract/client` exports `createApiClient` with response validation and rejection of undocumented status codes. `@luma/api-contract/openapi` is a separate server/tooling entry point so schema generation does not enter browser bundles.

Business endpoints use `/v1`. Additive changes may stay in v1; removing/renaming fields, changing types or narrowing accepted inputs requires a new major path and an explicit migration. Keep route keys stable because they form OpenAPI operation IDs. Health/readiness probes remain unversioned.

New resources add schemas and routes to the shared contract, implement the owning module's application port and API mapping, then wire its composition factory in `app.ts`. Only module API layers may import the root contract export; inner layers remain framework independent. Declare every intended response status and use strict mutation objects to reject unexpected tenant/region fields.

Tenant resources must follow ADR-003: `/v1/organizations/:organizationId/<resource>`, camelCase fields and UUID organization IDs. Shared schemas reserve `EU | US | APAC`; only EU provisioning is enabled. Identity guards verify session, membership, organization state and placement before tenant routes are served. Never treat path IDs or caller-supplied region/context as authorization. Provisioning rejects inactive regions with `422 REGION_UNAVAILABLE`; wrong-cell execution uses `503 REGION_UNAVAILABLE`.

## Errors and probes

Errors have `{ code, message, requestId }`; `x-request-id` matches the server request ID. Validation returns `400 VALIDATION_ERROR`. Unknown resources/routes return `404 NOT_FOUND`. Parser failures normalize 400/413/415. Unexpected exceptions and invalid handler output return sanitized `500 INTERNAL_ERROR`, with details only in server logs. Client response schemas are validated at runtime. Responses use `Cache-Control: no-store`.

Authenticated routes declare `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND` for inaccessible tenants/resources, and regional errors where applicable. See the [identity guide](identity.md) for session routes and tenant authorization.

`/health` reports process liveness without probing dependencies. `/ready` checks the identity database, schema and restricted runtime role. `buildApp` accepts an injected readiness check, returning 503 on false, exceptions or a one-second timeout. Future checks must bound/cancel their own I/O; the HTTP timeout does not cancel an underlying dependency operation. Shutdown marks the app as draining before closing connections; pending readiness checks cannot return ready after draining begins. Existing SIGINT/SIGTERM handling closes Fastify.

## OpenAPI and verification

The server serves the generated OpenAPI 3 document at `/openapi.json`. The committed SDK artifact is `packages/api-contract/openapi.json`.

```sh
pnpm --filter @luma/api-contract generate:openapi
pnpm format
pnpm check
```

Contract tests reject a stale artifact and check concrete schemas, parameters, error responses and unique operation IDs. API tests cover real HTTP with the typed client, path/query validation, response validation, sanitized failures, parser errors and readiness failures/timeouts. Web tests exercise the Query consumer and reject malformed responses before caching.

The stable ts-rest packages are pinned to 3.52.1 with Zod 3.25.76 isolated to the transport packages; existing web forms keep Zod 4. The stable adapter declares a Fastify 4 peer even though the repository uses Fastify 5.12.5. A version-specific `peerDependencyRules.allowedVersions` exception permits this pairing; strict peer checking remains enabled elsewhere. Real HTTP and error-path tests cover the integration. Review/remove this exception when upgrading ts-rest; it is not upstream certification of Fastify 5 support. See the [ts-rest adapter](https://ts-rest.com/server/fastify) and [upstream Fastify 5 work](https://github.com/ts-rest/ts-rest/pull/702).

## Request tracing

Responses include a server-generated `x-request-id`. When observability is wired, `x-trace-id` identifies the trace in Sentry and Langfuse. Send a UUIDv4 `x-luma-action-id` to correlate related requests from one user action. Invalid action IDs are ignored. These IDs provide diagnostics, not authentication or tenant access. See the [observability guide](observability.md).

## Exception Desk

Tenant-scoped [case reads](case-inbox.md) include bounded evidence pagination.
[Decision and progress APIs](case-decisions.md) provide immutable proposal review,
approve/reject/escalate commands, retry receipts, execution and verification reads,
audit history and authenticated SSE. All contracts and the stream client are
exported by `@luma/api-contract`; overview and installed-connection endpoints retain
their existing module ownership.

## Workspace Activity

The tenant-scoped [Activity API](workspace-activity.md) searches recorded decisions,
execution and resolution history with bounded date ranges and cursor pagination.
The shared contract defines searchable fields, outcome distinctions and role-based visibility.
