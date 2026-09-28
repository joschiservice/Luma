# Model gateway

LUMA-24 provides a `ModelGateway` port in `platform/index.ts`. Application services depend on this port; provider protocols stay in infrastructure. The API composition root creates one gateway at startup, exposes it as `app.modelGateway` and passes it to application services through `ApplicationOptions.modelGateway`. No public generation endpoint is installed.

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

Example for public or synthetic input:

```dotenv
MODEL_GATEWAY_ROUTES={"reasoning":{"adapter":"vercel","model":"anthropic/claude-sonnet-4.5","providers":["anthropic"],"zeroDataRetention":true}}
```

To change providers, replace the model and provider allowlist in the profile, for example with `openai/gpt-4.1` and `["openai"]`. Check model availability and structured output/tool support in the provider account. Application requests continue to use `profile: 'reasoning'`. Unknown profiles, empty provider lists, partial credentials and invalid route settings fail closed. Route errors never include configuration values or secrets.

Set the three required Bedrock variables together. Startup fails when a `bedrock-eu` route has no Bedrock settings, when the settings are partial, or when the region is not in the list above. London (`eu-west-2`) and Zurich (`eu-central-2`) are outside the EU and are rejected.

`ModelRoutingPolicy` can choose another configured profile or return `null` to deny a request. It sees the profile and data policy, not the prompt. Selected routes must still satisfy mandatory residency and retention checks. Routes and provider lists are copied and frozen at composition. Credentials, destination URLs and provider options are not request parameters.

## Workflow authoring profile

Natural-language workflow authoring sends workflow descriptions, field names, supplier names and example records to the model. These are tenant data. Authoring services use `authoringModelProfile` (`'authoring'`, exported by `@luma/platform`) with `dataPolicy: { classification: 'sensitive', region: 'EU', zeroDataRetention: true }`. Route this profile to Bedrock in the EU:

```dotenv
MODEL_GATEWAY_BEDROCK_REGION=eu-central-1
MODEL_GATEWAY_BEDROCK_ACCESS_KEY_ID=<access key ID>
MODEL_GATEWAY_BEDROCK_SECRET_ACCESS_KEY=<secret access key>
MODEL_GATEWAY_ROUTES={"authoring":{"adapter":"bedrock-eu","model":"eu.anthropic.claude-sonnet-4-5-20250929-v1:0","providers":["bedrock"],"zeroDataRetention":true}}
```

Callers reach the model only through their own authorized application services; there is no public generation endpoint. Complete the [processing-path review](architecture/003-model-processing-path-review.md) before sending tenant data.

Describing workflows ([Describe a workflow](workflows.md#describe-a-workflow)) is the authoring caller. The runtime composition enables it only when the `authoring` route uses `bedrock-eu` with `zeroDataRetention: true` and Bedrock settings exist (`packages/application-runtime/src/composition/authoring.ts`); otherwise its availability endpoint and every generation request return a reason, and no model is called. The service authorizes the caller before building model input, sends every request as `sensitive` EU data with zero retention, and uses structured output limited to the workspace's installed vocabulary. It makes at most three calls per request, re-asking with server diagnostics, under one 60-second deadline combined with the client's cancellation. It records the route, token usage and a hash of the request text; prompts and answers stay out of logs and traces. Gateway errors become a retry message and never include model text.

| Situation                                                                                    | Result                                                                 |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| No `authoring` route                                                                         | `route_denied`                                                         |
| `bedrock-eu` route without Bedrock settings, or a region outside the EU                      | Startup error                                                          |
| Route with `zeroDataRetention: false`                                                        | `route_denied`                                                         |
| Route to Vercel                                                                              | `route_denied`, or `adapter_unavailable` when Vercel is not configured |
| Global, non-EU or ARN model ID, or an `eu.` profile that can route outside the EU            | `route_denied`, before the prompt is sent                              |
| Account retention mode is not `none`, invocation logging delivers payloads, or a check fails | `adapter_unavailable`, before the prompt is sent                       |
| Throttled by Bedrock                                                                         | `rate_limited`                                                         |
| Other Bedrock errors                                                                         | `provider_error`                                                       |
| Deadline reached or caller cancelled                                                         | `timeout` or `aborted`                                                 |
| Truncated, filtered, refused or malformed output                                             | `invalid_output`                                                       |

## Data policy

Applications assign `dataPolicy` after authorization. Classify the whole input, including system messages, retrieved context, tool definitions and tool results. Any tenant or personal data is `sensitive`, requires `region: 'EU'` and uses a route with zero data retention. Trace context is correlation metadata, not authorization. Never accept the classification or profile directly from an HTTP body.

The Vercel adapter accepts only `public` input with `region: 'unrestricted'`. Requests requiring EU processing fail before network I/O. Vercel's [regional inference](https://vercel.com/docs/ai-gateway/security-and-compliance/regional-inference) pins provider inference but does not pin gateway TLS termination and processing. This does not meet [ADR-003](architecture/003-tenant-isolation-and-data-residency.md). Do not use that adapter for tenant prompts, even with zero data retention enabled.

The adapter sends the configured provider allowlist through `providerOptions.gateway.only` and retention through `zeroDataRetention`. Providers outside the list cannot be used as fallbacks. Luma performs no automatic retries or model fallback. Failures return a fixed `ModelGatewayError` code; callers may escalate or explicitly retry under the same policy. No response bodies or upstream exception causes appear in errors. Redirects are rejected.

Use the `bedrock-eu` route for tenant data. Composition installs it from the Bedrock settings and requires its declared processing region to be EU. Without Bedrock settings, a `bedrock-eu` route returns `adapter_unavailable`; it never falls back to Vercel or a global route. The declaration is not evidence of provider compliance; the [processing-path review](architecture/003-model-processing-path-review.md) records what is verified and what an operator must confirm.

## Bedrock EU adapter

The adapter calls the Amazon Bedrock [Converse API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html) at `https://bedrock-runtime.<region>.amazonaws.com` for the configured region. It signs requests with AWS Signature Version 4 and rejects redirects. It does not retry and never switches region, route or adapter.

Use an `eu.` cross-region inference profile, such as `eu.anthropic.claude-sonnet-4-5-20250929-v1:0`, or a foundation model ID that runs in the configured region, such as `anthropic.claude-3-haiku-20240307-v1:0`. Global profiles (`global.`), other geographic profiles (`us.`, `us-gov.`, `apac.`, `jp.`, `au.`, `ca.`) and ARNs, including application inference profiles and provisioned throughput, fail with `route_denied` before any network call.

Before the first request, and again after five minutes, the adapter checks the AWS account in the configured region. Only successful checks are reused. No prompt is sent until all checks pass.

| Check                                 | Control plane request           | Passes when                                                                                 | Otherwise             |
| ------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------- | --------------------- |
| Data retention                        | `GET /data-retention`           | `mode` is `none`                                                                            | `adapter_unavailable` |
| Invocation logging                    | `GET /logging/modelinvocations` | Logging is off, or `textDataDeliveryEnabled` is `false` and no other data type is delivered | `adapter_unavailable` |
| Profile destinations (`eu.` profiles) | `GET /inference-profiles/<id>`  | Every destination region is in the EU region list                                           | `route_denied`        |

With retention mode `none`, Bedrock stores no inputs or outputs and rejects models that require retention, for example models retained for [abuse detection](https://docs.aws.amazon.com/bedrock/latest/userguide/abuse-detection.html). Set it in the configured region with `PUT /data-retention` and `{"mode":"none"}`; see [data retention](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html). A request that fails any check never reaches the runtime endpoint.

Grant the IAM principal `bedrock:InvokeModel` on the `eu.` profile in the configured region and on the foundation model in every destination region, plus `bedrock:GetAccountDataRetention`, `bedrock:GetModelInvocationLoggingConfiguration` and `bedrock:GetInferenceProfile`. Use a dedicated principal without other permissions. The adapter does not refresh temporary credentials; restart with new values before a session token expires.

Structured output uses a tool named after the output schema. The adapter forces that tool and returns its input as the JSON output, which the gateway then validates. Output schemas must describe a JSON object, and the model must support forced tool choice. When tools are also declared, the model must call either a declared tool or the output tool. System messages become Converse system prompts. Tool results become user content, and consecutive messages with the same role are merged. Stop reasons other than `end_turn` and `tool_use`, such as `max_tokens`, `guardrail_intervened` or `content_filtered`, fail with `invalid_output`. HTTP 429 and `ThrottlingException` return `rate_limited`; other failures return `provider_error` without reading the response body. Bedrock reports token usage but not cost, so `costUsd` is `null`.

## Requests and outputs

```ts
const result = await modelGateway.generate(traceContext, {
  profile: 'reasoning',
  dataPolicy: {
    classification: 'public',
    region: 'unrestricted',
    zeroDataRetention: true,
  },
  messages: [{ role: 'user', content: 'Explain an inventory reservation.' }],
  maxOutputTokens: 256,
});
// result.output is a string, or null when tool calls are proposed.
```

For structured output, provide `output: ModelSchema<T>` with a stable name, JSON Schema and matching `parse(unknown): T` function. The Vercel adapter requests strict JSON Schema output and the Bedrock adapter forces an output tool; the gateway parses and validates the response locally in both cases. Keep the schema and parser aligned. Refused, truncated, malformed or invalid responses fail with `invalid_output`.

Tools carry a name, description and input schema/parser. Returned calls include their ID, name and parsed JSON arguments. The gateway rejects undeclared tools, duplicate call IDs and arguments that fail the parser. Parsers validate tool arguments; their transformed return values are not used. Tool proposals have `output: null`. The gateway never executes tools. Pass write proposals through the existing policy/approval/execution services, then append an assistant message containing the calls and tool messages referencing their IDs. Before provider I/O, historical calls must have non-empty, unique IDs and match the currently declared tools and input schemas. Every assistant tool batch must be followed by exactly one result per call, in any order, before another turn. Incomplete, orphaned or duplicate results fail with `invalid_request`. Each call generates one response; the caller owns the bounded reasoning loop.

`maxOutputTokens` is required and bounded to 1–32768. An optional `AbortSignal` cancels a call. Results expose adapter, configured model, input/output tokens, latency and `costUsd`. No automatic model fallback means the configured model identifies the requested route; provider-specific revision names are not exposed. Missing cost is `null`, never zero. The Chat Completions response guarantees token usage but not billed cost, so this adapter returns `null`; Langfuse can calculate cost from its model catalog. Other adapters can supply an actual USD cost through the same port. These values are diagnostic metadata, not billing records.

## Tracing and verification

Each call creates a `model.generate` generation under the explicit parent trace. Only startup-approved model names, token counts, latency and reported cost are attached. Prompts, responses, tool data, credentials and upstream errors are excluded. The existing Langfuse masking and exporter restrictions remain active; SDK auto-instrumentation is not enabled.

Tests run with intercepted HTTP responses and in-memory Langfuse export. They do not contact paid providers. Every adapter runs the shared contract suite in `packages/platform/src/infrastructure/model-adapter-contract.test.ts`: text, structured output, tool proposals and history, invalid output, HTTP and network errors, cancellation, deadlines, and redaction of prompts, responses, tool data and credentials from errors and exported traces. Add a fixture there for each new adapter. Gateway tests cover configuration-based provider switching, denied egress and tool history. Bedrock tests cover the region list, model ID rules, account checks, profile destinations, message mapping and the sensitive authoring route. The signer is tested against published AWS Signature Version 4 examples and signatures produced by the AWS SDK signer.

To verify an account, configure a route and credentials, invoke the port with synthetic data, and inspect the provider records and matching Langfuse trace. For Bedrock, CloudTrail records each `Converse` call in the configured region; `additionalEventData.inferenceRegion` shows where an `eu.` profile processed it. Tenant data requires operator sign-off on the processing-path review.

References: [Vercel Chat Completions](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions), [provider routing](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options), [zero data retention](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr), [Langfuse OpenTelemetry attributes](https://langfuse.com/integrations/native/opentelemetry), [Bedrock cross-region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html), [model invocation logging](https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html), [Bedrock CloudTrail events](https://docs.aws.amazon.com/bedrock/latest/userguide/logging-using-cloudtrail.html), [Signature Version 4](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html).
