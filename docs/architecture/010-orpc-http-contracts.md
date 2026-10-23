# ADR-010: HTTP contracts with oRPC and one Zod version

Status: accepted · 2026-10-09 · [LUMA-151](https://linear.app/auren-labs/issue/LUMA-151)

## Context

The HTTP contract, typed client and OpenAPI document were built with ts-rest. Its last stable release, 3.52.1, supports only Zod 3; Zod 4 support exists only in a 3.53 release candidate that was never published as stable, and the project has had no release since. With Zod 4, 3.52.1 loses request and response type inference and generates empty OpenAPI schemas.

The web app and UI used Zod 4, so the workspace installed both versions. Vite pre-bundles one copy of a package per name, so story tests could resolve every `zod` import to Zod 3 depending on scan order, and the bad mapping persisted in the cache. Keeping ts-rest also required a Fastify 4 peer exception and a pnpm hook that gave Better Auth a private Zod 4.

## Options considered

- **Stay on ts-rest 3.52.1.** No migration, but Zod 3 forever and the version split with its tooling failures stays.
- **ts-rest 3.53 release candidate.** Type inference works with Zod 4 and OpenAPI generation accepts a custom schema transformer, but it pins an unreleased build of an inactive project.
- **oRPC 2.0 beta.** Zod 4 only, but betas still change routing metadata, error status handling and the wire format between releases, with no stable date.
- **Plain Fastify routes with Zod.** No dependency, but the typed client and OpenAPI generation would have to be written and maintained here.
- **oRPC 1.x.** Stable, maintained, contract-first, validates through Standard Schema and serves REST routes through its OpenAPI handler.

## Decision

Use oRPC 1.x, pinned, and one Zod 4 version across the workspace.

- **Unchanged HTTP surface.** Routes keep their URLs, methods, statuses and the `{ code, message, requestId }` error body. Contracts use oRPC's detailed input structure, so handlers and clients receive `params`, `query`, `headers` and `body` separately.
- **Fastify stays in charge of routing.** Each contract route is registered as its own Fastify route that hands the request to oRPC. Hooks keep seeing the matched route pattern, and the identity guard reads the access declared in route metadata. A single catch-all route would hide both.
- **One error path.** Handler failures reach the Fastify error handler unchanged. Input validation failures become `400 VALIDATION_ERROR`; invalid handler output becomes a sanitized `500`.
- **Documented statuses in metadata.** Routes list their error statuses in metadata, and the OpenAPI document adds the shared error schema for them. oRPC error maps are keyed by error code with their own body shape, which does not fit the status-keyed shared error body.
- **Client.** Calls resolve with the validated response body and reject with an error carrying the status and error body.
- **Event streams** stay plain Fastify routes; the OpenAPI document describes them from their route records.

## Consequences

- The OpenAPI document moves from 3.0 to 3.1. Operation IDs stay the router keys.
- oRPC 2.0 changes routing metadata, error status handling and client options. Upgrading is a separate, deliberate migration.
- Requests are matched twice, by Fastify and by oRPC; the cost is negligible next to the handlers.
- Fastify answers `HEAD` with the `GET` route; the bridge passes such requests to oRPC as `GET`.

Reversal cost: medium. Contracts and handlers use oRPC builders across the contract package and about 30 route files, but URLs, payloads and errors stayed the same, so clients outside the web app are unaffected.

## Revisited: deriving the contract from server routers

Reviewed 2026-10-23; the decision stands.

oRPC can derive the client contract from a server router. A build-time macro (`unplugin-macros` for Vite) calls `minifyRouterContract(await unlazyRouter(router))` and inlines the result as JSON, and the client is typed through `import type` of the router. Routes would be declared once, next to their handlers, without a separate contract or server code in the browser bundle.

The minified contract keeps only methods, paths, error maps and metadata; schemas are stripped. The client would lose response validation, which needs the Zod schemas at runtime. Adding validation ourselves was considered:

- **Inline JSON Schema and validate in the browser.** The web CSP forbids `unsafe-eval`, so Ajv could not compile at runtime; a custom build plugin would have to generate standalone validators. The OpenAPI document is several megabytes, so validators would need per-route splitting. JSON Schema does not express Zod refinements and transforms exactly, so client and server could disagree on the same response.
- **Move schemas into server-free modules shared by router and client.** Validation keeps working, but those modules are the contract without method and path. The macro would save a few lines per route.
- **Drop client response validation.** The server already validates handler output and returns a sanitized `500`. The client check additionally catches version skew between a loaded web bundle and a newer API, and responses altered by proxies.

Other costs apply regardless of validation. The web typecheck would resolve every domain package's route and service types. The web build would import and construct the backend router in Node, so import-time side effects in backend packages could break it, and backend sources would become web build inputs. Runtime values shared with clients, such as collection catalogs and stream event schemas, still need a server-free package.

The documented macro setup targets oRPC 2.0, which is still a beta. Its breaking changes remove `status` from errors and move routing into OpenAPI metadata, both of which the Fastify bridge, the error path and the client rely on. Upgrading stays a separate migration once 2.0 is stable.

Contracts stay in `@luma/api-contract`. A smaller alternative, if the separate package becomes a burden, is for each domain package to own its contract in a server-free subpath that `@luma/api-contract` assembles. That would need its own decision because it changes package ownership in [ADR-005](005-domain-packages-and-runtimes.md).
