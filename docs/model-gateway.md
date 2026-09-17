# Model gateway

LUMA-24 provides a `ModelGateway` port in `platform/index.ts`. Application services depend on this port; provider protocols stay in infrastructure. The API composition root creates one gateway at startup and exposes it as `app.modelGateway` for injection into services. No public generation endpoint is installed.

## Configuration

| Variable                   | Behavior                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `MODEL_GATEWAY_ROUTES`     | JSON object mapping application profiles to routes; defaults to `{}` (calls denied) |
| `AI_GATEWAY_API_KEY`       | Required for Vercel routes; server-only secret                                      |
| `MODEL_GATEWAY_TIMEOUT_MS` | Request timeout, including reading the response; 1–120000 ms, default 30000         |

Example for public or synthetic input:

```dotenv
MODEL_GATEWAY_ROUTES={"reasoning":{"adapter":"vercel","model":"anthropic/claude-sonnet-4.5","providers":["anthropic"],"zeroDataRetention":true}}
```

To change providers, replace the model and provider allowlist in the profile, for example with `openai/gpt-4.1` and `["openai"]`. Check model availability and structured output/tool support in the provider account. Application requests continue to use `profile: 'reasoning'`. Unknown profiles, empty provider lists, partial credentials and invalid route settings fail closed. Route errors never include configuration values or secrets.

`ModelRoutingPolicy` can choose another configured profile or return `null` to deny a request. It sees the profile and data policy, not the prompt. Selected routes must still satisfy mandatory residency and retention checks. Routes and provider lists are copied and frozen at composition. Credentials, destination URLs and provider options are not request parameters.

## Data policy

Applications assign `dataPolicy` after authorization. Classify the whole input, including system messages, retrieved context, tool definitions and tool results. Any tenant or personal data is `sensitive`, requires `region: 'EU'` and uses a route with zero data retention. Trace context is correlation metadata, not authorization. Never accept the classification or profile directly from an HTTP body.

The Vercel adapter accepts only `public` input with `region: 'unrestricted'`. Requests requiring EU processing fail before network I/O. Vercel's [regional inference](https://vercel.com/docs/ai-gateway/security-and-compliance/regional-inference) pins provider inference but does not pin gateway TLS termination and processing. This does not meet [ADR-003](architecture/003-tenant-isolation-and-data-residency.md). Do not use that adapter for tenant prompts, even with zero data retention enabled.

The adapter sends the configured provider allowlist through `providerOptions.gateway.only` and retention through `zeroDataRetention`. Providers outside the list cannot be used as fallbacks. Luma performs no automatic retries or model fallback. Failures return a fixed `ModelGatewayError` code; callers may escalate or explicitly retry under the same policy. No response bodies or upstream exception causes appear in errors. Redirects are rejected.

`bedrock-eu` reserves a route adapter ID. Composition accepts a `bedrockEu: ModelAdapter` implementation, requires its declared full processing region to be EU, and applies the same output, retention and trace conventions. Without that implementation, the route returns `adapter_unavailable`; it never falls back globally. A production Bedrock adapter must pin EU endpoints, prohibit global inference profiles, enforce retention, cancellation and timeouts, and pass adapter contract tests. The declaration is not evidence of provider compliance; verify the full processing path before deployment.

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

For structured output, provide `output: ModelSchema<T>` with a stable name, JSON Schema and matching `parse(unknown): T` function. The adapter requests strict JSON Schema output; the gateway also parses and validates the response locally. Keep the schema and parser aligned. Refused, truncated, malformed or invalid responses fail with `invalid_output`.

Tools carry a name, description and input schema/parser. Returned calls include their ID, name and parsed JSON arguments. The gateway rejects undeclared tools, duplicate call IDs and arguments that fail the parser. Parsers validate tool arguments; their transformed return values are not used. Tool proposals have `output: null`. The gateway never executes tools. Pass write proposals through the existing policy/approval/execution services, then append an assistant message containing the calls and tool messages referencing their IDs. Each call generates one response; the caller owns the bounded reasoning loop.

`maxOutputTokens` is required and bounded to 1–32768. An optional `AbortSignal` cancels a call. Results expose adapter, configured model, input/output tokens, latency and `costUsd`. No automatic model fallback means the configured model identifies the requested route; provider-specific revision names are not exposed. Missing cost is `null`, never zero. The Chat Completions response guarantees token usage but not billed cost, so this adapter returns `null`; Langfuse can calculate cost from its model catalog. Other adapters can supply an actual USD cost through the same port. These values are diagnostic metadata, not billing records.

## Tracing and verification

Each call creates a `model.generate` generation under the explicit parent trace. Only startup-approved model names, token counts, latency and reported cost are attached. Prompts, responses, tool data, credentials and upstream errors are excluded. The existing Langfuse masking and exporter restrictions remain active; SDK auto-instrumentation is not enabled.

Tests run with intercepted HTTP responses and in-memory Langfuse export. They demonstrate the same workflow switching models/providers through configuration, denied egress, unavailable Bedrock, tool history, invalid output, HTTP/network errors, cancellation, deadlines and metadata redaction. They do not contact paid providers. To verify an account, configure a route and credentials, invoke the port with synthetic data, and inspect the provider dashboard and matching Langfuse trace. Tenant-data activation requires a separately approved EU adapter.

References: [Vercel Chat Completions](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions), [provider routing](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options), [zero data retention](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr), [Langfuse OpenTelemetry attributes](https://langfuse.com/integrations/native/opentelemetry).
