import { createHash } from 'node:crypto';

import { replenishmentSource } from '@luma/procurement';
import { shippingMethodPlaybook } from '@luma/resolution';
import { processDraftFromPlaybook } from '@luma/workflows';
import {
  authoringPromptVersion,
  createAuthoringHarness,
} from '@luma/workflows/composition';

/** Resolves a case's reference workflow: a built-in definition or inline content. */
export function referenceContent(reference) {
  if (reference.kind === 'replenishment') {
    const content = structuredClone(replenishmentSource);
    delete content.provenance;

    return content;
  }
  if (reference.kind === 'shipping-method')
    return processDraftFromPlaybook(shippingMethodPlaybook, 'resolution');
  if (reference.kind === 'content') return reference.content;
  throw new Error(`Unknown reference kind: ${reference.kind}`);
}

/**
 * The parts two workflows must share to be equivalent: how they start, their ordered step kinds,
 * the data sources, actions and result checks they use, and the fields their conditions test.
 */
function structure(content) {
  const steps = content.steps;
  const sorted = (items) => [...new Set(items)].sort();
  const trigger = content.applicability.trigger;

  return {
    trigger: trigger.kind,
    steps: steps.map((step) => step.kind),
    reads: sorted(steps.filter((s) => s.kind === 'read').map((s) => s.source)),
    capabilities: sorted(
      steps
        .filter((s) => s.kind === 'capability')
        .map((s) => `${s.capability}@${s.capabilityVersion}`),
    ),
    evaluators: sorted(
      steps
        .filter((s) => s.kind === 'verification')
        .map((s) => s.evaluatorVersion),
    ),
    conditions: [
      ...(trigger.kind === 'condition' ? [trigger.field] : []),
      ...steps.filter((s) => s.kind === 'condition').map((s) => s.field),
    ],
  };
}

/** Lists the structural differences between a generated workflow and its reference. */
export function differences(generated, reference) {
  const actual = structure(generated);
  const expected = structure(reference);

  return Object.keys(expected).flatMap((key) =>
    JSON.stringify(actual[key]) === JSON.stringify(expected[key])
      ? []
      : [
          `${key}: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(actual[key])}`,
        ],
  );
}

/**
 * Describes every corpus case through the production authoring path and measures the valid-draft
 * rate and structural equivalence to each reference. Model failures count as invalid drafts.
 */
export async function evaluateAuthoring(
  corpus,
  { gateway, maxAttempts, dataRegion = process.env.LUMA_REGION ?? 'AU' },
) {
  const harness = createAuthoringHarness({
    dataRegion,
    gateway,
    vocabulary: corpus.vocabulary,
    ...(maxAttempts ? { maxAttempts } : {}),
  });
  const cases = [];
  let route = null;
  for (const item of corpus.cases) {
    const run = await harness.describe(item.prompt);
    if (run.route.model) route = run.route;
    const errors =
      run.draft?.diagnostics.filter((d) => d.severity === 'error') ?? [];
    const found = run.draft
      ? differences(run.draft.content, referenceContent(item.reference))
      : ['no draft'];
    cases.push({
      id: item.id,
      outcome: run.draft?.outcome ?? 'failed',
      failure: run.failure,
      valid: run.draft?.outcome === 'valid',
      equivalent: found.length === 0,
      differences: found,
      errors: errors.map((d) =>
        `${d.stepId ?? 'workflow'} ${d.field ?? ''}: ${d.code}`.trim(),
      ),
      questions: run.draft?.questions.length ?? 0,
      attempts: run.attempts,
      usage: run.usage,
    });
  }
  const rate = (key) =>
    cases.length ? cases.filter((item) => item[key]).length / cases.length : 0;

  return {
    corpusVersion: corpus.corpusVersion,
    corpusDigest: createHash('sha256')
      .update(JSON.stringify(corpus))
      .digest('hex'),
    promptVersion: authoringPromptVersion,
    route,
    validDraftRate: rate('valid'),
    equivalenceRate: rate('equivalent'),
    cases,
  };
}
