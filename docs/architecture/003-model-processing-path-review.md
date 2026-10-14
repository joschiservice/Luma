# ADR-003 review: regional model processing

Status: pending platform-operator and legal sign-off. No production cell is deployed.
Tenant data must remain disabled until account-specific processing, retention and support
evidence is approved for that cell. This review applies
[ADR-003](003-tenant-isolation-and-data-residency.md) to the regional `bedrock` route;
configuration alone is not evidence of physical processing.

## Processing and enforced boundaries

Workflow descriptions, supplier names, example records, retrieved context and tool
arguments/results are sensitive tenant data. Callers carry the trusted tenant region;
the gateway requires the adapter's region to match and requires zero retention. An
unrestricted route, including Vercel AI Gateway, cannot process sensitive input.

The adapter calls the configured regional Bedrock control plane before sending data.
It checks account retention mode `none`, invocation logging without payload delivery,
and all destination model ARNs for an approved geographic inference profile. Successful
checks are reused for at most five minutes by default; failed checks are not cached.
Calls use signed HTTPS with redirects rejected, no fallback adapter and no cross-cell
retry. Telemetry receives only approved metadata; prompts and responses are excluded.

| Cell | Source endpoint and models                                                                                                       | Profile and destination boundary                                                                                                                                                                                                 |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AU   | Launch source is Sydney `ap-southeast-2`; select a model supporting Sydney in-region inference or an approved Australia profile. | Only `au.` profiles whose returned destinations are Sydney or Melbourne. Reject APAC, global, JP, EU, US profiles and arbitrary ARNs. Melbourne is reserved for in-country recovery or an explicitly reviewed Australia profile. |
| EU   | Approved AWS regions in EU member states; no London endpoint.                                                                    | `eu.` profiles with EU-only destinations.                                                                                                                                                                                        |
| US   | Approved US AWS regions.                                                                                                         | `us.` profiles with US-only destinations.                                                                                                                                                                                        |

[AWS provides AU profile discovery from Sydney](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html).
Query `ListInferenceProfiles` and `GetInferenceProfile` from the selected source region;
AWS explicitly requires destination inspection rather than relying on the profile prefix.
Current model availability belongs to the model's regional availability page and the
account's returned profile inventory. No production model/profile is selected or certified
by this document, so it does not invent a static list of runnable model IDs.

AWS states that [retention mode `none`](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html)
prevents durable input/output storage and rejects models requiring retention; the setting
is per region. [Abuse-detection retention](https://docs.aws.amazon.com/bedrock/latest/userguide/abuse-detection.html)
depends on the model and can apply in a profile's destination region. The adapter checks
the source setting; an operator must verify destination settings and AWS's applicable
cross-region retention behavior before enabling a profile.
[Geographic inference](https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html)
uses encrypted AWS network links but can process outside the source region. A profile
being available is not approval to use its destinations.

## Required activation evidence

The platform operator records the production account, source region, model/profile and
IAM principal; applies policies denying unapproved jurisdictions and global inference;
and verifies retention `none` plus disabled payload logging at every destination. Keep
credentials and rotation in the cell's secret store. Verify TLS termination and egress
from the production network, including proxies and interface endpoints. A development
DNS or certificate check cannot establish that production path.

Security and privacy review the selected model's retention eligibility, AWS terms and
subprocessors, operator access and customer-provided support data. AU review must include
Japan-based Luma support, the employing legal entity and applicable overseas-handling
rules described in [the residency decision](003-tenant-isolation-and-data-residency.md#residency-promise-and-subprocessor-review).

Run a synthetic production-configured inference and inspect CloudTrail's destination
region plus in-cell trail storage, ensuring no prompt/response content. Inspect any
Langfuse deployment and its backups separately; AU prompt tracing remains disabled until
Sydney self-hosting is approved. Provider statements about
[data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html)
and [CloudTrail](https://docs.aws.amazon.com/bedrock/latest/userguide/logging-using-cloudtrail.html)
are supporting evidence, not inspection of the configured account.

| Approval                                           | State                                             |
| -------------------------------------------------- | ------------------------------------------------- |
| Actual AU/EU/US account processing and retention   | Pending; no production infrastructure to inspect. |
| AU service schedule and Japan support legal review | Pending.                                          |
| Platform operator                                  | Pending.                                          |
| Security and privacy                               | Pending.                                          |

Re-open the review when the model, profile, region, retention, logging, subprocessors or
support countries change. Unavailable approved processing stops the request; it does not
permit overseas fallback.
