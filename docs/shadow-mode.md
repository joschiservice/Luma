# Shadow Mode

Shadow Mode evaluates what a Playbook would do for a real case without dispatching
anything. Evaluations are recorded with `mode: "shadow"` and `executed: false`; a
completed Shadow workflow ends in phase `shadow_completed` and never resolves a case.
Predictions and operator comparisons stay separate from live verified-success metrics.
`@luma/resolution` owns the service; every operation requires a freshly refreshed context
with `playbooks.activate`.

## Evaluations

An evaluation ID is a client-chosen UUID. Keep it for retries: exact retries return the
original snapshot, including its timestamp and diagnosis revision, and reusing it with a
different principal, source or Playbook fails. Use a new ID for a new observation.

There are two ways to evaluate:

- **Workflow.** A Shadow workflow detects the case, gathers evidence through the normal
  authorized diagnosis path, prepares a candidate, records the policy preview and
  simulation, and stops. Cases with insufficient evidence or no candidate are still
  recorded. With a `prepareShadow` binding the candidate is built through Playbook preview,
  which validates the Playbook inputs without publishing a proposal, persisting an
  executable run or granting admission; without it, Shadow reads an existing retained
  proposal. Shadow workflow IDs are separate from live ones, and Shadow never calls live
  proposal preparation or binds itself as the case's live workflow. Run a dedicated
  Shadow deployment with execution disabled.
- **Direct.** Evaluating an existing proposal reads the retained current diagnosis and
  proposal; it does not refresh production observations. An expired or superseded
  candidate cannot produce a successful prediction. A proposal that already has an
  execution attempt is rejected, so nobody evaluates a prediction after seeing its result.

Execute, reconcile and live verification reject Shadow inputs even when called directly.
The Shadow service has no provider or execution dependency, and the candidate is kept
inside the immutable evaluation.

## Prediction and policy preview

`shipping-method-shadow/1` supports `orders.shipping-method.write` version `0` with the
`shipping-method/1` verifier. It predicts the bound shipping method, assuming the provider
accepts the write and an authoritative reread follows. It does not predict shipment or
fulfillment. Other capabilities and verification models are inconclusive, with no
simulated effects.

The policy preview applies execution's policy rules without saving an approval or
execution decision, and evaluates the approval requirement before any operator approval.
The shipping-method capability keeps its high risk floor, and a Playbook that requires
approval stays approval-required even for a low-risk action. The preview checks retained
activation grants and freshness; it is not a live provider-availability check or
permission to execute.

## Operator reviews

After acting, an operator records whether action was needed, whether the case was
eligible, the observed action (`null` when unknown; it may target a different record) and
optional feedback (`trust`, `distrust`, `unsure` or null). Evidence must belong to the
incident. Reviews are attributed to the current reviewer and immutable; conflicting
retries fail. Operator assessments are observations, not authoritative verification.

## Comparison reports

A report covers one workflow and evaluation timestamps in `[since, until)`. It uses the
latest evaluation per incident and fails above 500 incidents; narrow the window instead.
Windows select evaluations, while eventual outcomes reflect the evidence available when
the report is read.

An authoritative outcome is a later completed incident or execution verification with
the same evaluator version. Execution observations must concern the same case,
connection, capability, target and expected postcondition and fall within the pinned
Playbook verification deadline after the execution attempt. A passing incident
verification counts only if it was accepted. Unknown, incomplete, unrelated and resultless
failed attempts are not outcomes.

Each rate reports numerator, denominator and a value that is null for an empty
denominator. A proposed action is an eligible candidate that policy did not deny:

| Rate                                     | Numerator / denominator                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Agreement                                | Proposed actions whose business fields match the observed operator action / those with one         |
| False positives                          | Reviewed proposed actions assessed as unnecessary / reviewed proposed actions                      |
| Missed eligible cases                    | Cases without an eligible, policy-permitted proposal / reviewed cases assessed eligible and needed |
| Prediction agreement                     | Matching predictions / conclusive predictions with an outcome from the same evaluator              |
| Projected autonomous resolution          | Allowed proposals with a supported passing prediction / evaluated incidents                        |
| Projected unnecessary human intervention | Autonomous candidates matching an observed operator action / observed operator interventions       |
| Trust                                    | `trust` / (`trust` + `distrust`); unknown and `unsure` are excluded                                |
