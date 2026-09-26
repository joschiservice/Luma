import type { PlaybookIR, PlaybookScalar } from '@luma/workflows';

type Action = {
  capability: string;
  capabilityVersion?: string;
  target: { kind: string; id: string };
  parameters: Record<string, PlaybookScalar>;
  expectedPostcondition: Record<string, PlaybookScalar>;
};

type Evaluation = {
  eligibility: string;
  policy: { outcome: string } | null;
  candidate: { action: Action } | null;
  simulation: { predictedOutcome: string; evaluatorVersion: string | null };
};

type Comparison = {
  evaluation: Evaluation;
  review: {
    operatorAction: Action | null;
    eligible: boolean;
    actionNeeded: boolean;
    feedback: string | null;
  } | null;
  actual: { outcome: string; evaluatorVersion: string } | null;
};

/** Predicts the bounded shipping-method postcondition under explicit provider acceptance assumptions. */
export function simulateShadow(
  action: Action | null,
  ir: PlaybookIR | null,
  eligible: boolean,
) {
  const supported =
    action?.capability === 'orders.shipping-method.write' &&
    action.capabilityVersion === '0' &&
    ir?.verification.evaluatorVersion === 'shipping-method/1' &&
    typeof action.expectedPostcondition.shippingMethodId === 'string' &&
    action.expectedPostcondition.shippingMethodId.length > 0 &&
    Object.keys(action.expectedPostcondition).length === 1;
  const simulated = supported && eligible;

  return {
    modelVersion: 'shipping-method-shadow/1' as const,
    effects: simulated ? { ...action!.expectedPostcondition } : {},
    predictedOutcome: simulated
      ? ('passed' as const)
      : ('inconclusive' as const),
    evaluatorVersion: ir?.verification.evaluatorVersion ?? null,
    assumptions: simulated
      ? [
          'The provider accepts the mapped shipping method.',
          'An authoritative reread confirms the method within the verification window.',
          'A corrected shipping method does not establish shipment or fulfillment.',
        ]
      : ['No supported simulation establishes the expected outcome.'],
  };
}

/** Aggregates observed comparisons; missing evidence is excluded and each rate includes its denominator. */
export function shadowMetrics(
  rows: Comparison[],
  sameAction: (a: Action | null, b: Action | null) => boolean,
) {
  const rate = (values: boolean[]) => ({
    numerator: values.filter(Boolean).length,
    denominator: values.length,
    rate: values.length ? values.filter(Boolean).length / values.length : null,
  });
  const proposed = (e: Evaluation) =>
    e.eligibility === 'eligible' && e.policy?.outcome !== 'denied';
  const autonomous = (e: Evaluation) =>
    proposed(e) &&
    e.policy?.outcome === 'allowed' &&
    e.simulation.predictedOutcome === 'passed';
  const reviewed = rows.filter((r) => r.review !== null);
  const operators = reviewed.filter((r) => r.review!.operatorAction !== null);
  const outcomes = rows.filter(
    (r) =>
      r.actual &&
      r.actual.evaluatorVersion === r.evaluation.simulation.evaluatorVersion &&
      r.evaluation.simulation.predictedOutcome !== 'inconclusive',
  );

  return {
    evaluations: rows.length,
    reviewed: reviewed.length,
    agreementWithOperator: rate(
      operators
        .filter((r) => proposed(r.evaluation))
        .map((r) =>
          sameAction(r.evaluation.candidate!.action, r.review!.operatorAction),
        ),
    ),
    falsePositiveActionRate: rate(
      reviewed
        .filter((r) => proposed(r.evaluation))
        .map((r) => !r.review!.actionNeeded),
    ),
    missedEligibleCases: rate(
      reviewed
        .filter((r) => r.review!.eligible && r.review!.actionNeeded)
        .map((r) => !proposed(r.evaluation)),
    ),
    predictedVsActualOutcome: rate(
      outcomes.map(
        (r) => r.actual!.outcome === r.evaluation.simulation.predictedOutcome,
      ),
    ),
    projectedAutonomousResolutionRate: rate(
      rows.map((r) => autonomous(r.evaluation)),
    ),
    projectedUnnecessaryHumanInterventionRate: rate(
      operators.map(
        (r) =>
          autonomous(r.evaluation) &&
          sameAction(r.evaluation.candidate!.action, r.review!.operatorAction),
      ),
    ),
    operatorTrust: rate(
      reviewed
        .filter(
          (r) => r.review!.feedback !== null && r.review!.feedback !== 'unsure',
        )
        .map((r) => r.review!.feedback === 'trust'),
    ),
  };
}
