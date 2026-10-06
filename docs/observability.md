# Observability baseline

For local tracing, CPU/memory profiling, query timing, and dashboards without a vendor account, run `pnpm dev:observe`. See [Local performance diagnostics](local-observability.md).

LUMA-9 adds server-side Sentry errors/performance, Langfuse observations and PostHog events/flags. Each provider is optional. Telemetry is disabled locally unless configured; the API still needs the identity database and auth settings described in the [identity guide](identity.md). The browser sends an action ID through the typed API client; it does not load vendor SDKs, cookies, replay or autocapture.

## Setup

Copy `apps/api/.env.example` to `.env`. Set credentials only for providers you want to enable. Use separate projects and tenant hash secrets for development, staging and production.

| Setting                                      | Behavior                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `OBSERVABILITY_ENVIRONMENT`                  | `development`, `test`, `staging` or `production`; defaults to `development`                                                             |
| `OBSERVABILITY_RELEASE`                      | Release identifier, such as a commit SHA; defaults to `local`                                                                           |
| `OBSERVABILITY_SAMPLE_RATE`                  | Trace sampling from 0 to 1; defaults to 1. All spans in a trace share the decision. Errors and explicit product events are independent. |
| `OBSERVABILITY_TENANT_HASH_KEY`              | Random secret of at least 32 characters, required whenever any telemetry exporter is enabled                                            |
| `SENTRY_DSN`                                 | EU Sentry project DSN on `o<org>.ingest.de.sentry.io`                                                                                   |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | Both keys enable Langfuse; a partial pair fails startup                                                                                 |
| `LANGFUSE_BASE_URL`                          | `https://cloud.langfuse.com`                                                                                                            |
| `POSTHOG_API_KEY`                            | PostHog project key; enables explicit events and remote flag evaluation                                                                 |
| `POSTHOG_HOST`                               | `https://eu.i.posthog.com`                                                                                                              |

Other ingestion hosts are rejected. EU endpoints enforce the initial egress boundary; operators must also verify project processing location, access and retention under [ADR-003](architecture/003-tenant-isolation-and-data-residency.md). Set retention in each provider before enabling customer traffic. There is no cross-region fallback.

The runtime initializes identity and telemetry before accepting requests. Closing the server flushes spans, shuts down processors, then drains analytics and Sentry. Network timeouts are bounded. Flag failures return the caller's fallback (false by default); analytics failures do not fail requests. Flags never replace authorization checks.

## Correlation and use

- `x-luma-action-id`: UUIDv4 created by `createUserActionHeaders()`. Reuse for related calls and retries. The provider query uses this header. Invalid values are discarded.
- `x-request-id`: new server-generated UUID for each HTTP request. Incoming request IDs are ignored.
- `x-trace-id`: server-generated OpenTelemetry trace ID returned in the response. Sentry and Langfuse use this same native trace ID; PostHog includes `trace_id`, `request_id` and `action_id`.
- `spanId`: identifies a step. Pass the immutable `TraceContext` explicitly through workflow, agent, model and tool operations. Concurrent requests never share an ambient tenant context.

`platform/index.ts` exposes a framework-independent `Observability` interface. Inject it into module application services from composition roots. Vendor SDK imports stay in the platform infrastructure adapter.

```ts
await observability.run(context, 'workflow.run', async (workflow) => {
  await observability.run(workflow, 'agent.run', async (agent) => {
    await observability.run(
      agent,
      'model.generate',
      async (_model, observation) => {
        const result = await generate();
        observation.generation({
          model: 'test-model',
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        });
        return result;
      },
    );
    await observability.run(agent, 'tool.execute', async () => executeTool());
  });
});
```

The model allowlist contains `test-model` and the model identifiers from validated startup routes. The [model gateway](model-gateway.md) records model identity, token counts, latency and reported cost, never arguments or return values. Span names, product event names and flag keys are explicit allowlists; extend them in code review instead of using customer content as names.

The API binds telemetry to `request.tenantContext` after the identity guard succeeds. Handlers pass `request.observation.context` to application services. For background work, use `forTenant(context, authorizedTenantId, 'EU')` after reauthorization. It exports an environment-specific HMAC as `tenant_ref`; raw organization/user IDs are not exported. This pseudonym is still restricted metadata. Startup rejects enabled exporters without a hash secret. The adapter rejects unsupported placement. With all exporters disabled and no hash key, local requests retain correlation without tenant metadata. Never derive tenant context from a header, body or analytics ID. Reauthorize any persisted workflow envelope before resuming it; trace context alone grants no authority.

`connector_provider_viewed` is emitted on a successful correlated provider lookup. `observability_test_completed` and the `observability-test` flag support verification. Tenant flag evaluation uses the pseudonymous tenant reference; anonymous evaluation uses the action/request ID. Automatic flag exposure events and person profiles are disabled.

## Data policy

General telemetry contains deployment metadata, opaque correlation IDs, tenant HMACs, fixed operation names, status, timing, approved model names, token counts, model latency and reported cost. Error reports additionally contain the diagnostic fields described under [error reports](#error-reports). There is no general-purpose metadata bag. Do not add emails, names, addresses, commerce identifiers, prompts, completions, tool arguments/results, URLs, query strings, request bodies, headers, cookies or credentials.

Sentry default integrations and hosted automatic instrumentation are disabled; only linked errors and process-level error capture are enabled. The opt-in local adapter instruments HTTP and PostgreSQL, with export-level redaction tested separately. Langfuse exports only this adapter's tracer and masks input/output/metadata fields as a second boundary. Media upload is disabled. PostHog disables GeoIP, exception autocapture, automatic flag events and person profiles. Application HTTP logs contain generated request IDs, trace IDs and status, plus error details for failed requests; default request logging is disabled.

Future integrations must retain these rules. In particular, enabling framework/model auto-instrumentation requires export-level redaction tests before deployment.

## Error reports

Unexpected failures are reported with their error type, message, stack, code and up to five linked causes:

- API requests that end with an internal server error, and failed readiness checks. Validation, payload-size and media-type errors and deliberate API errors such as `NOT_FOUND` or `SERVICE_UNAVAILABLE` are responses, not reports.
- Temporal activity failures, described below.
- Commerce sync worker failures: sync passes, supplier follow-up and scheduled detection. The fixed log message, such as `Sync pass failed; retrying.`, names the operation.
- Uncaught exceptions and unhandled promise rejections when Sentry is configured. The process still exits as Node would.

Sentry events contain the exception, correlation tags (`request_id`, `action_id`, `trace_id`, `tenant_ref`) and, for requests, the route pattern and method as tags and a redacted request with method, URL and headers:

- **URLs:** route words and UUIDs stay. Other path values become their route parameter name, such as `:skuId`, or `[Filtered]` when no route matched. Query values are `[Filtered]` except bounded view parameters such as `window`, `limit`, `sort` and `status`. Search text, cursors and OAuth codes and state stay filtered.
- **Headers:** cookies, authorization, tokens, secrets, sessions, signatures and HMACs, API keys, CSRF tokens, AWS signing headers, Shopify shop domains and client IP addresses are `[Filtered]`. The referrer is redacted like a request URL.

Request bodies, users, breadcrumbs, extras and custom error properties, such as PostgreSQL's `detail`, are never added. Error messages and stacks can still contain tenant or provider values, for example a provider error text. URLs can contain organization and record UUIDs. Restrict the Sentry project to the people who handle production incidents, keep EU ingestion and set retention before enabling it.

Process logs on stderr carry the same error details as `error` with `type`, `message`, `code`, `stack` and `cause`. The API logs `Request failed` with trace ID, method and route; workers log the operation message. Logs contain no URLs, headers or bodies.

Temporal activity failures also produce a worker diagnostic log named `Workflow activity failed before sanitization`. It contains the original thrown error, including its stack and cause, and Temporal's workflow ID, run ID, activity ID, activity type, and attempt. The default worker logger writes to stderr. When `SENTRY_DSN` is configured, both the regular worker and the pilot also capture the original exception in Sentry, including linked causes and a `temporal` context with these identifiers. Error capture is independent of trace sampling. Worker shutdown flushes pending events. These diagnostic logs and Sentry events can contain provider details and require restricted access. Activity arguments, custom error properties, and ambient user or request data are not added to the Sentry event. In local diagnostics, the worker also logs the failure to Loki as `Workflow activity failed`. Temporal history continues to receive sanitized failures. Use the workflow, run, activity, and attempt fields to match a diagnostic entry to an `Activity failed` warning.

## Verification

```sh
pnpm --filter @luma/api test
pnpm --filter @luma/config test
TEST_DATABASE_URL=postgresql://postgres:<password>@127.0.0.1:5432/luma_test pnpm check
```

The API integration test sends an action ID and deliberately sensitive headers, query and body data. It runs a deterministic workflow → agent → model/tool operation and checks the parent hierarchy, shared IDs, analytics, token counts and absence of sensitive values. It also checks concurrent tenant isolation, rejected authorization without tenant metadata, errors, flag outages and shutdown. The exporter test exercises the real Sentry and Langfuse SDKs with in-memory transports; no vendor account is contacted.

For an account-level check, configure EU credentials, run `pnpm dev`, then call the provider endpoint with a UUIDv4 `x-luma-action-id`. Find the returned `x-trace-id` in Sentry and Langfuse and the same ID on PostHog's `connector_provider_viewed` event. Dashboard ingestion and account settings require this separate live check. The deterministic model/tool fixture is test-only; no public diagnostic endpoint or paid model call is added.

SDK references: [Sentry custom OpenTelemetry setup](https://docs.sentry.io/platforms/javascript/guides/node/opentelemetry/custom-setup/), [Langfuse setup](https://langfuse.com/docs/observability/sdk/overview), [Langfuse masking and filtering](https://langfuse.com/docs/observability/sdk/advanced-features), [PostHog Node SDK](https://posthog.com/docs/libraries/node).
