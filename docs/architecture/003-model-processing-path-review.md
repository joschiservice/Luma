# ADR-003 review: model processing path for tenant authoring prompts

Status: pending operator sign-off. Prepared 2026-09-28 for [LUMA-93](https://linear.app/auren-labs/issue/LUMA-93). Do not send tenant data through the `authoring` profile until every open item below is closed and signed off.

This review applies [ADR-003](003-tenant-isolation-and-data-residency.md) to the `bedrock-eu` model route. ADR-003 requires tenant prompts, retrieved context, tool arguments and results, and provider logs to use an approved EU processing endpoint and retention configuration, with no global fallback. The adapter's `region: 'EU'` declaration is not evidence on its own. This document separates what the code enforces, what was observed, and what an operator must still confirm with AWS evidence. Configuration and failure modes are in [the model gateway guide](../model-gateway.md).

## Data and processing path

Natural-language workflow authoring sends workflow descriptions, field names, supplier names and example records. These are tenant data and are classified `sensitive`.

1. An authorized application service in the EU cell calls `ModelGateway.generate` with profile `authoring` and `dataPolicy: { classification: 'sensitive', region: 'EU', zeroDataRetention: true }`.
2. The gateway accepts only a configured route whose adapter declares EU processing and whose route requires zero retention.
3. The adapter reads the account's data retention mode, invocation logging configuration and, for `eu.` profiles, the profile's destination regions from `https://bedrock.<region>.amazonaws.com`. These requests carry no tenant data.
4. The adapter sends the prompt over HTTPS to `https://bedrock-runtime.<region>.amazonaws.com/model/<model>/converse`. The TLS connection is made to that regional endpoint; item 7 confirms where it terminates in production.
5. For an `eu.` profile, Bedrock may process the request in any destination region of the profile. AWS states that this traffic stays on the AWS network and is encrypted in transit.
6. The response returns on the same connection. Telemetry receives only the approved model name, token counts and latency.

## Controls enforced in code

| Control                                          | Enforcement                                                                                                                                                                               | Test evidence                                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Sensitive input only on EU zero-retention routes | Gateway denies sensitive input unless the region is EU, the adapter declares EU processing and the route requires zero retention.                                                         | `model-gateway.test.ts`, `bedrock-eu-model-adapter.test.ts` |
| EU regional endpoint                             | Only `eu-central-1`, `eu-west-1`, `eu-west-3`, `eu-north-1`, `eu-south-1` and `eu-south-2` are accepted, in configuration and again in the adapter. Hostnames are built from that region. | Config and adapter tests                                    |
| No redirection                                   | Every request uses `redirect: 'error'`.                                                                                                                                                   | Adapter tests                                               |
| No global or non-EU profiles                     | `global.`, `us.`, `us-gov.`, `apac.`, `jp.`, `au.`, `ca.` and ARNs are denied before any network call.                                                                                    | Adapter tests                                               |
| `eu.` profile destinations                       | `GetInferenceProfile` must list only EU region destinations; otherwise `route_denied`.                                                                                                    | Adapter tests                                               |
| AWS-side retention                               | Account data retention mode in the configured region must be `none`; otherwise `adapter_unavailable`.                                                                                     | Adapter tests                                               |
| Customer-side invocation logs                    | Text logging must be explicitly off and no other payload type delivered; otherwise `adapter_unavailable`.                                                                                 | Adapter tests                                               |
| Fail closed                                      | Checks run before the prompt is sent. Failed or unreachable checks are not cached. No retries, fallback routes or fallback adapters.                                                      | Adapter and gateway tests                                   |
| Trace and error redaction                        | Prompts, responses, tool data, credentials and upstream errors are absent from errors, spans and Langfuse export.                                                                         | `model-adapter-contract.test.ts`                            |
| Request authentication                           | Signature Version 4 matches published AWS examples and the AWS SDK signer, including double-encoded model IDs and session tokens.                                                         | `aws-signature.test.ts`                                     |

The adapter can verify only what the Bedrock control plane exposes for the configured region. It cannot observe where AWS terminates or forwards traffic internally, which region's retention setting governs cross-region requests, or contractual terms.

## Observations on 2026-09-28

These observations support the review but do not replace the open items. They were made from a development workstation, not from the production network.

- `bedrock-runtime.eu-central-1.amazonaws.com` resolved to `52.59.11.62`, `63.183.243.195` and `63.185.42.159`. `bedrock.eu-central-1.amazonaws.com` resolved to `3.78.82.165`, `35.157.5.191` and `3.65.209.252`. All six addresses are in `eu-central-1` prefixes of AWS [`ip-ranges.json`](https://ip-ranges.amazonaws.com/ip-ranges.json) (created `2026-09-28-05-57-06`).
- The runtime endpoint negotiated TLS 1.3 and presented a certificate for `bedrock-runtime.eu-central-1.amazonaws.com` issued by Amazon RSA 2048 M04.
- AWS documentation retrieved the same day states:
  - Bedrock does not store model inputs or outputs by default, but stores them for abuse detection for specific models. The list includes several OpenAI GPT-5.x models and Anthropic Claude Fable 5 and 5.1, with retention of up to 30 days. For cross-region inference, retained data is stored in the destination region. See [abuse detection](https://docs.aws.amazon.com/bedrock/latest/userguide/abuse-detection.html).
  - Retention mode `none` means no request or response data is written to durable storage by AWS or shared with the model provider. Models that require retention are rejected. The setting applies per region and does not propagate. See [data retention](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html).
  - Geographic cross-region inference stays within the geography, but prompts and outputs can leave the source region. CloudTrail logs each request in the source region with `additionalEventData.inferenceRegion`. See [geographic cross-region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html) and [cross-region inference](https://docs.aws.amazon.com/bedrock/latest/userguide/cross-region-inference.html).
  - Model providers have no access to the Bedrock deployment accounts, logs, prompts or completions. See [data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html).
  - `Converse` is recorded as a CloudTrail management event. See [CloudTrail](https://docs.aws.amazon.com/bedrock/latest/userguide/logging-using-cloudtrail.html).

## Open verification items

Each item needs recorded evidence before tenant data is enabled. Attach exports or links in the evidence column.

| #   | Item                              | Evidence required                                                                                                                                                                                                                                     | Owner                | Evidence | Status  |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------- | ------- |
| 1   | Production AWS account and region | Account ID, configured region, and an SCP that denies Bedrock outside the approved EU regions and denies global inference (`aws:RequestedRegion` `unspecified`)                                                                                       | Platform operator    |          | Pending |
| 2   | Retention mode `none`             | `GET /data-retention` output for the configured region and every destination region of the profile; SCP denying `bedrock:PutAccountDataRetention` unless the mode is `none`; AWS confirmation of which region's setting governs cross-region requests | Platform operator    |          | Pending |
| 3   | Model eligibility                 | The selected model is not on the abuse-detection retention list, and AWS or Anthropic confirms zero retention for it                                                                                                                                  | Security and privacy |          | Pending |
| 4   | Profile destinations              | `GetInferenceProfile` output for the selected `eu.` profile and the model page's regional availability; all destinations are EU regions                                                                                                               | Platform operator    |          | Pending |
| 5   | Invocation logging                | `GetModelInvocationLoggingConfiguration` output showing logging off or metadata only                                                                                                                                                                  | Platform operator    |          | Pending |
| 6   | CloudTrail                        | `Converse` events contain no prompt or response content; trail storage is in the EU; sample `inferenceRegion` values from a synthetic call are EU regions                                                                                             | Platform operator    |          | Pending |
| 7   | TLS termination and egress        | DNS, IP-range and certificate check from the production network; no TLS-intercepting proxy or egress point outside the EU; decision on a VPC interface endpoint for `bedrock-runtime`                                                                 | Platform operator    |          | Pending |
| 8   | Contract terms                    | AWS GDPR data processing addendum and service terms covering Bedrock; Bedrock's no-storage and zero-operator-access statements apply to the selected model                                                                                            | Security and privacy |          | Pending |
| 9   | Subprocessors and support access  | AWS subprocessor list for Bedrock; confirmation that model providers are not subprocessors for inference; support access requires customer-provided data                                                                                              | Security and privacy |          | Pending |
| 10  | Credentials                       | Dedicated IAM principal limited to the documented actions; secret storage in the EU; rotation owner and schedule                                                                                                                                      | Platform operator    |          | Pending |
| 11  | Synthetic end-to-end run          | A synthetic authoring request with production configuration, its CloudTrail event and its Langfuse trace containing only metadata                                                                                                                     | Engineering          |          | Pending |

Record changes to the model, profile, region or AWS terms as a new review. Re-run items 2 to 6 and 11 when they change.

## Sign-off

| Role                 | Name | Date | Decision |
| -------------------- | ---- | ---- | -------- |
| Platform operator    |      |      | Pending  |
| Security and privacy |      |      | Pending  |
