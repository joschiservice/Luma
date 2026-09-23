# Shadow Mode

Shadow Mode evaluates production observations without dispatching the proposed action. Its records have `mode: "shadow"` and `executed: false`. A completed Shadow workflow has phase `shadow_completed`; it never marks a case resolved.

## Use the workspace UI

Owners and admins can open an issue and use **Shadow evaluation** to select a Playbook and run a prediction against the retained diagnosis and bound candidate. The result is labeled **Shadow — not executed** and shows eligibility, policy, predicted effects, assumptions and any authoritative outcome. Refreshing or reopening the case reloads the latest saved evaluation.

Use **Save operator comparison** to record whether action was needed, whether the case was eligible, the observed action and optional trust feedback. Choose incident evidence to support the assessment. An alternative action can use a different target. Reviews are immutable; uncertain saves retry the same review.

Open **Compare cases**, or the Playbook's **Shadow comparisons** section, to select an inclusive UTC date range. Each rate shows its numerator and denominator. Missing observations remain unknown. The report uses the latest evaluation per case and supports up to 500 cases per range.

## Run a bounded workflow

Choose a published Playbook definition and its reviewed activation, with explicit principals, connections and targets. Keep the existing ingestion and diagnosis bindings. Supply `bindings.prepareShadow` to build a candidate through `playbooks.preview`; this validates the Playbook inputs without publishing a proposal, persisting an executable run or granting admission. Without that binding, Shadow reads an existing retained proposal. Pass `application.http.shadow` as the final argument to `createExceptionWorkflowRuntime` and start the workflow through:

```ts
await client.startShadow(context, source, {
  id: evaluationId,
  workflow: 'shipping-method-correction',
});
```

The evaluation ID must be a UUID. Retain it for retries. Reusing it with a different principal, source or Playbook fails. Use a new ID for a new observation. Shadow workflow IDs are separate from live workflow IDs. Configure the worker with disabled execution for a dedicated Shadow deployment.

The workflow detects the case, gathers evidence through the existing authorized diagnosis path, prepares a candidate, records the policy preview and simulation, and stops. Cases with insufficient evidence or no candidate are still recorded. `execute`, `reconcile` and live `verify` reject Shadow inputs even if called directly. The Shadow service has no provider or execution dependency. The candidate is retained inside the immutable Shadow evaluation. Shadow does not call live proposal preparation or bind itself as the live case workflow.

An existing prepared proposal can also be evaluated directly:

```http
POST /v1/organizations/{organizationId}/exceptions/{exceptionId}/shadow
Content-Type: application/json

{"id":"<evaluation UUID>","workflow":"shipping-method-correction"}
```

This endpoint reads the retained current diagnosis and proposal; it does not refresh production observations. An expired or superseded candidate cannot produce a successful prediction. A proposal with an execution attempt is rejected to avoid evaluating it after seeing its result. Exact retries return the original snapshot, including its timestamp and diagnosis revision.

## Prediction model

`shipping-method-shadow/1` supports `orders.shipping-method.write` version `0` with the `shipping-method/1` verifier. It predicts the bound shipping method under explicit provider-acceptance and authoritative-reread assumptions. It does not predict shipment or fulfillment. Other capabilities or verification models remain inconclusive with no simulated effects.

The policy preview uses the same policy rules as execution, without saving an approval or execution decision. It evaluates the approval requirement before any operator approval. The shipping-method capability retains its high risk floor. A Playbook that requires approval remains approval-required even if the action risk is low. The preview checks retained activation grants and freshness; it is not a live provider-availability check or permission to execute.

## Compare multiple incidents

After an operator acts, record a review:

```http
POST /v1/organizations/{organizationId}/shadow/{evaluationId}/review
Content-Type: application/json

{
  "actionNeeded": true,
  "eligible": true,
  "operatorAction": {
    "capability": "orders.shipping-method.write",
    "target": {"kind":"order","id":"<order UUID>"},
    "parameters": {},
    "expectedPostcondition": {"shippingMethodId":"mapped-method"}
  },
  "evidenceRefs": ["<incident evidence UUID>"],
  "occurredAt": "2026-09-23T12:01:00.000Z",
  "feedback": "trust"
}
```

Use `operatorAction: null` when the intervention is unknown. Feedback accepts `trust`, `distrust`, `unsure`, or null. Evidence must belong to the incident. Reviews are attributed to the current owner or admin and retained immutably. Conflicting retries fail.

Read `/v1/organizations/{organizationId}/shadow` with `workflow`, `since` and `until` query parameters. The window includes evaluation timestamps from `since` through, but excluding, `until`. Reports retain the latest evaluation per incident and accept at most 500 incidents; narrow the window if it is larger. Authoritative outcomes are read from subsequent completed incident or execution verification evidence with the same evaluator version. Execution observations must concern the same case, connection, capability, target and expected postcondition. Passing incident verification must have been accepted. Execution observations must fall within the pinned Playbook verification deadline measured from the execution attempt. Unknown, incomplete, unrelated and failed verification attempts without a result do not count as outcomes.

Each rate includes a numerator, denominator and nullable value:

- Agreement: matching business action fields among proposed actions with an observed operator action.
- False positives: reviewed proposed actions assessed as unnecessary, divided by reviewed proposed actions.
- Missed eligible cases: cases without an eligible, policy-permitted proposal, divided by reviewed cases assessed as eligible and needing action.
- Prediction agreement: matching predictions and authoritative outcomes using the same evaluator.
- Projected autonomous resolution: allowed proposals with a supported passing prediction, divided by evaluated incidents.
- Projected unnecessary human intervention: those autonomous candidates matching an observed operator action, divided by observed operator interventions.
- Trust: `trust` responses divided by `trust` and `distrust` responses. Unknown and unsure responses are excluded.

Operator assessments are observations, not authoritative verification. Empty denominators return null. Predictions remain separate from live verified-success metrics. Report windows select evaluations; eventual outcomes reflect the evidence available when the report is read.
