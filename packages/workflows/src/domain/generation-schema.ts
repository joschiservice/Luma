import type { PlaybookFields } from './playbook.js';
import type { AuthoringVocabulary, ValueOption } from './vocabulary.js';

type SchemaValue =
  | null
  | boolean
  | number
  | string
  | SchemaValue[]
  | { [key: string]: SchemaValue };

/** A JSON Schema document sent to the model as its required output shape. */
export type JsonSchema = Record<string, SchemaValue>;

const key: JsonSchema = {
  type: 'string',
  pattern: '^[a-z][a-zA-Z0-9_-]{0,79}$',
};
const text = (maxLength: number): JsonSchema => ({ type: 'string', maxLength });
const choice = (values: string[]): JsonSchema => ({
  type: 'string',
  enum: values,
});
const scalar: JsonSchema = {
  anyOf: [
    { type: 'string', maxLength: 2000 },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
  ],
};
const fieldType = choice(['string', 'number', 'boolean', 'null']);
const seconds = (maximum: number): JsonSchema => ({
  type: 'integer',
  minimum: 1,
  maximum,
});

function object(
  properties: Record<string, JsonSchema>,
  required: string[] = Object.keys(properties),
): JsonSchema {
  return { type: 'object', additionalProperties: false, required, properties };
}

const value: JsonSchema = {
  anyOf: [
    object({ source: choice(['input']), field: key }),
    object({ source: choice(['evidence']), field: key }),
    object({ source: choice(['literal']), value: scalar }),
    object({ source: choice(['step']), stepId: key, field: key }),
  ],
};

/** Any subset of the declared fields, each with its declared type. */
const subsetOf = (declared: PlaybookFields): JsonSchema =>
  object(
    Object.fromEntries(
      Object.entries(declared).map(([name, type]) => [name, choice([type])]),
    ),
    [],
  );

const valuesFor = (declared: PlaybookFields): JsonSchema =>
  object(
    Object.fromEntries(Object.keys(declared).map((name) => [name, value])),
  );

const freeFields: JsonSchema = {
  type: 'object',
  maxProperties: 64,
  additionalProperties: fieldType,
};

const risks = ['low', 'medium', 'high'] as const;

/** Whether this workspace can add Code Steps to a draft. */
export function codeStepsAvailable(vocabulary: AuthoringVocabulary): boolean {
  return vocabulary.codeSteps.executable || vocabulary.codeSteps.evaluation;
}

/**
 * Builds the `workflow/2` content schema limited to this workspace's installed vocabulary: its
 * subjects, data sources with their fields, actions with their values, and result checks. Code
 * Steps are offered only when the workspace can run or evaluate them.
 */
function contentSchema(vocabulary: AuthoringVocabulary): JsonSchema {
  const step = (kind: string, properties: Record<string, JsonSchema>) =>
    object({ id: key, kind: choice([kind]), ...properties });
  const steps: JsonSchema[] = [
    ...vocabulary.reads.map((read) =>
      step('read', {
        source: choice([read.source]),
        fields: subsetOf(read.fields),
      }),
    ),
    step('condition', {
      field: key,
      equals: scalar,
      onFalse: choice(['escalate', 'end']),
    }),
    ...vocabulary.capabilities.map((action) =>
      step('capability', {
        capability: choice([action.capability]),
        capabilityVersion: choice([action.version]),
        targetKind: choice([action.targetKind]),
        minimumRisk: choice(risks.slice(risks.indexOf(action.minimumRisk))),
        parameters: valuesFor(action.parameters),
        expectedPostcondition: valuesFor(action.postcondition),
      }),
    ),
    step('approval', { forStep: key, expiresAfterSeconds: seconds(86_400) }),
    step('wait', { seconds: seconds(86_400) }),
    ...vocabulary.evaluators.map((evaluator) =>
      step('verification', {
        forStep: key,
        evaluatorVersion: choice([evaluator.version]),
        maxDurationSeconds: seconds(300),
        fields: subsetOf(evaluator.fields),
      }),
    ),
    step('escalation', { reason: text(200) }),
    step('end', { outcome: text(200) }),
    ...(codeStepsAvailable(vocabulary)
      ? [
          step('code', {
            source: text(32_768),
            fields: freeFields,
            grants: { type: 'array', maxItems: 16, items: key },
            limits: object(
              Object.fromEntries(
                Object.entries(vocabulary.codeSteps.limits).map(
                  ([name, limit]) => [name, { type: 'integer', enum: [limit] }],
                ),
              ),
            ),
          }),
        ]
      : []),
  ];
  const subjects = vocabulary.subjects.map((item) => item.kind);

  return object({
    schemaVersion: { type: 'integer', enum: [2] },
    definition: object({
      id: key,
      name: text(200),
      intent: text(2000),
      category: text(200),
    }),
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    applicability: object({
      trigger: {
        anyOf: [
          object({ kind: choice(['manual']) }),
          object({ kind: choice(['event']), eventType: text(200) }),
          object({
            kind: choice(['schedule']),
            at: { type: 'string', format: 'date-time' },
          }),
          object({ kind: choice(['condition']), field: key, equals: scalar }),
          object({ kind: choice(['exception']), issueType: text(200) }),
        ],
      },
      subjectKind: subjects.length ? choice(subjects) : text(200),
    }),
    inputs: freeFields,
    context: object({
      kind: text(200),
      fields: freeFields,
      maxAgeSeconds: seconds(300),
    }),
    steps: {
      type: 'array',
      minItems: 2,
      maxItems: 32,
      items: { anyOf: steps },
    },
  });
}

/**
 * The output schema for describing or refining a workflow: draft content limited to installed
 * vocabulary, a plain-language explanation per step, assumptions and open questions.
 */
export function draftOutputSchema(vocabulary: AuthoringVocabulary): JsonSchema {
  return object({
    content: contentSchema(vocabulary),
    steps: {
      type: 'array',
      maxItems: 32,
      items: object({ stepId: key, explanation: text(500) }),
    },
    assumptions: { type: 'array', maxItems: 20, items: text(500) },
    questions: {
      type: 'array',
      maxItems: 20,
      items: object({
        stepId: { anyOf: [key, { type: 'null' }] },
        field: text(200),
        question: text(500),
      }),
    },
  });
}

/**
 * The output schema for a generated Code Step: TypeScript source, returned fields, grants limited
 * to the reads and actions directly after the step, and example cases using the values in scope.
 */
export function codeStepOutputSchema(
  scope: ValueOption[],
  grantable: string[],
): JsonSchema {
  const named = (source: ValueOption['source']) =>
    object(
      Object.fromEntries(
        scope
          .filter((option) => option.source === source)
          .map((option) => [option.field, scalar]),
      ),
      [],
    );
  const outputs = new Map<string, string[]>();
  for (const option of scope)
    if (option.source === 'step' && option.stepId)
      outputs.set(option.stepId, [
        ...(outputs.get(option.stepId) ?? []),
        option.field,
      ]);
  const anyValues: JsonSchema = {
    type: 'object',
    maxProperties: 64,
    additionalProperties: scalar,
  };

  return object({
    source: text(32_768),
    fields: { ...freeFields, minProperties: 1 },
    grants: grantable.length
      ? { type: 'array', maxItems: grantable.length, items: choice(grantable) }
      : { type: 'array', maxItems: 0, items: key },
    explanation: text(2000),
    examples: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: object({
        name: text(200),
        input: object({
          inputs: named('input'),
          evidence: named('evidence'),
          steps: object(
            Object.fromEntries(
              [...outputs].map(([stepId, fields]) => [
                stepId,
                object(
                  Object.fromEntries(fields.map((field) => [field, scalar])),
                  [],
                ),
              ]),
            ),
            [],
          ),
        }),
        replies: object(
          Object.fromEntries(grantable.map((grant) => [grant, anyValues])),
          [],
        ),
        expected: anyValues,
      }),
    },
  });
}
