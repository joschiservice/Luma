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
