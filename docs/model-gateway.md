# Model gateway

The `ModelGateway` port in `@luma/platform` is the only way application services call a
model. Provider protocols stay in infrastructure, model calls are denied until routes are
configured, and tenant or personal data may only go to an EU, zero-retention route.
There is no public generation endpoint: callers reach a model only through their own
authorized application services.

## Configuration

| Variable                                  | Behavior                                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `MODEL_GATEWAY_ROUTES`                    | JSON object mapping application profiles to routes; defaults to `{}` (calls denied)                                    |
| `AI_GATEWAY_API_KEY`                      | Required for Vercel routes; server-only secret                                                                         |
| `MODEL_GATEWAY_BEDROCK_REGION`            | Required for `bedrock-eu` routes: `eu-central-1`, `eu-west-1`, `eu-west-3`, `eu-north-1`, `eu-south-1` or `eu-south-2` |
| `MODEL_GATEWAY_BEDROCK_ACCESS_KEY_ID`     | Required for `bedrock-eu` routes; server-only                                                                          |
| `MODEL_GATEWAY_BEDROCK_SECRET_ACCESS_KEY` | Required for `bedrock-eu` routes; server-only secret                                                                   |
| `MODEL_GATEWAY_BEDROCK_SESSION_TOKEN`     | Set only with temporary AWS credentials; server-only secret                                                            |
| `MODEL_GATEWAY_TIMEOUT_MS`                | Request timeout, including Bedrock account checks and reading the response; 1–120000 ms, default 30000                 |

`apps/api/.env.example` has route examples for every profile. Unknown profiles, empty
provider lists, partial credentials and invalid route settings fail closed, and route
errors never include configuration values or secrets. Startup fails when a `bedrock-eu`
route has no or partial Bedrock settings, or a region outside the list; London
(`eu-west-2`) and Zurich (`eu-central-2`) are outside the EU.

`ModelRoutingPolicy` may pick another configured profile or return `null` to deny. It sees
the profile and data policy, never the prompt, and its choice must still pass residency and
retention checks. Routes are frozen at composition; credentials, destination URLs and
provider options are never request parameters.

### Local setup

Managed commands do not generate model settings; put them in `apps/api/.env`. Until a
`bedrock-eu` route exists, describing workflows, reading supplier messages and Ask Luma
report why they are unavailable and call no model. Seeded and simulator data is synthetic,
so the processing-path review does not block local use.

To enable them, create a dedicated IAM principal with the permissions under
[Bedrock EU adapter](#bedrock-eu-adapter), set the account's retention mode to `none` in the
configured region, copy the Bedrock variables and routes from `apps/api/.env.example`, and
restart `pnpm dev`. `pnpm evaluate:authoring` reads the same file and makes synthetic calls
through the `authoring` route.

## Data policy

Applications assign `dataPolicy` after authorization and classify the whole input,
including system messages, retrieved context, tool definitions and tool results. Any tenant
or personal data is `sensitive`, requires `region: 'EU'` and a zero-retention route. Never
take the classification or profile from an HTTP body. Trace context is correlation
metadata, not authorization.

The Vercel adapter accepts only `public` input with `region: 'unrestricted'`; EU requests
fail before network I/O. Vercel's
[regional inference](https://vercel.com/docs/ai-gateway/security-and-compliance/regional-inference)
pins provider inference but not gateway TLS termination and processing, so it does not meet
[ADR-003](architecture/003-tenant-isolation-and-data-residency.md). Never use it for tenant
prompts, even with zero data retention. It sends the provider allowlist and retention flag
to the gateway, so providers outside the list cannot be fallbacks.

Use `bedrock-eu` for tenant data. Without Bedrock settings it returns `adapter_unavailable`
and never falls back to Vercel or a global route. Its EU declaration is not evidence of
provider compliance: complete the
[processing-path review](architecture/003-model-processing-path-review.md) before sending
tenant data.

Luma performs no automatic retries or model fallback. Failures return a fixed
`ModelGatewayError` code without response bodies or upstream causes; callers may escalate or
retry explicitly under the same policy. Redirects are rejected.

## Profiles

The three tenant-data profiles share one rule: the feature is available only when its
profile routes to `bedrock-eu` with `zeroDataRetention: true` and Bedrock settings exist.
Otherwise the feature reports the reason and calls no model. Each sends `sensitive`, EU,
zero-retention requests.

| Situation                                                                                    | Result                                                                 |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| No route for the profile                                                                     | `route_denied`                                                         |
| `bedrock-eu` route without Bedrock settings, or a region outside the EU                      | Startup error                                                          |
| Route with `zeroDataRetention: false`                                                        | `route_denied`                                                         |
| Route to Vercel                                                                              | `route_denied`, or `adapter_unavailable` when Vercel is not configured |
| Global, non-EU or ARN model ID, or an `eu.` profile that can route outside the EU            | `route_denied`, before the prompt is sent                              |
| Account retention mode is not `none`, invocation logging delivers payloads, or a check fails | `adapter_unavailable`, before the prompt is sent                       |
| Throttled by Bedrock                                                                         | `rate_limited`                                                         |
| Other Bedrock errors                                                                         | `provider_error`                                                       |
| Deadline reached or caller cancelled                                                         | `timeout` or `aborted`                                                 |
| Truncated, filtered, refused or malformed output                                             | `invalid_output`                                                       |

### Workflow authoring profile

`authoring` ([Describe a workflow](workflows.md#describe-a-workflow)) sends workflow
descriptions, field names, supplier names and example records. It uses structured output
limited to the workspace's installed vocabulary, at most three calls per request under one
60-second deadline. It records the route, token usage and a hash of the request text;
prompts and answers stay out of logs and traces.

### Supplier extraction profile

`supplier-extraction` ([Supplier commitments](supplier-commitments.md#supplier-messages))
reads supplier messages. Without a route, messages are stored and people record facts by
selecting text.

### Assistant profile

`assistant` ([Ask Luma](assistant.md)) sends questions, earlier turns and read results. The
model must support tool use.

## Bedrock EU adapter

The adapter calls the Bedrock
[Converse API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)
in the configured region with Signature Version 4. It rejects redirects, does not retry, and
never switches region, route or adapter.

Use an `eu.` cross-region inference profile, such as
`eu.anthropic.claude-sonnet-4-5-20250929-v1:0`, or a foundation model that runs in the
configured region. Global (`global.`) and other geographic profiles (`us.`, `us-gov.`,
`apac.`, `jp.`, `au.`, `ca.`) and ARNs, including application inference profiles and
provisioned throughput, fail with `route_denied` before any network call.

Before the first request, and again after five minutes, the adapter checks the account in
the configured region. Only successful checks are reused; no prompt is sent until all pass.

| Check                                 | Control plane request           | Passes when                                                                                 | Otherwise             |
| ------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------- | --------------------- |
| Data retention                        | `GET /data-retention`           | `mode` is `none`                                                                            | `adapter_unavailable` |
| Invocation logging                    | `GET /logging/modelinvocations` | Logging is off, or `textDataDeliveryEnabled` is `false` and no other data type is delivered | `adapter_unavailable` |
| Profile destinations (`eu.` profiles) | `GET /inference-profiles/<id>`  | Every destination region is in the EU region list                                           | `route_denied`        |

With retention mode `none`, Bedrock stores no inputs or outputs and rejects models that
require retention, such as those retained for
[abuse detection](https://docs.aws.amazon.com/bedrock/latest/userguide/abuse-detection.html).
Set it in the configured region with `PUT /data-retention` and `{"mode":"none"}`; see
[data retention](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html).

Grant the IAM principal `bedrock:InvokeModel` on the `eu.` profile in the configured region
and on the foundation model in every destination region, plus
`bedrock:GetAccountDataRetention`, `bedrock:GetModelInvocationLoggingConfiguration` and
`bedrock:GetInferenceProfile`, and nothing else. The adapter does not refresh temporary
credentials; restart with new values before a session token expires.

Structured output uses a forced tool named after the output schema, so output schemas must
describe a JSON object and the model must support forced tool choice. When tools are also
declared, the model must call a declared tool or the output tool. Consecutive messages with
the same role are merged. Stop reasons other than `end_turn` and `tool_use` fail with
`invalid_output`. HTTP 429 and `ThrottlingException` return `rate_limited`; other failures
return `provider_error` without reading the body. Bedrock reports tokens but not cost, so
`costUsd` is `null`.

## Requests and outputs

- `maxOutputTokens` is required (1–32768). An optional `AbortSignal` cancels a call.
- Structured output takes a `ModelSchema` with a stable name, JSON Schema and matching
  parser. The gateway parses and validates the response locally for every adapter; keep
  schema and parser aligned. Invalid responses fail with `invalid_output`.
- The gateway never executes tools. It rejects undeclared tools, duplicate call IDs and
  arguments that fail the parser; parser return values are not used. Route write proposals
  through the policy, approval and execution services.
- Before provider I/O, historical calls must have unique IDs and match the currently
  declared tools. Every assistant tool batch needs exactly one result per call before the
  next turn; incomplete, orphaned or duplicate results fail with `invalid_request`. Each
  call generates one response; the caller owns the bounded loop.
- Results report adapter, configured model, tokens, latency and `costUsd`. Missing cost is
  `null`, never zero. These are diagnostic metadata, not billing records.

## Tracing and verification

Each call creates a `model.generate` generation under the explicit parent trace with only
startup-approved model names, token counts, latency and reported cost. Prompts, responses,
tool data, credentials and upstream errors are excluded, and SDK auto-instrumentation stays
off. Every adapter must pass the shared adapter contract suite in `@luma/platform`,
including redaction from errors and exported traces; add a fixture there for a new adapter.

To verify an account, configure a route and credentials, call the port with synthetic data,
and compare the provider records with the Langfuse trace. CloudTrail records each Bedrock
`Converse` call in the configured region; `additionalEventData.inferenceRegion` shows where
an `eu.` profile processed it. Tenant data requires operator sign-off on the processing-path
review.
