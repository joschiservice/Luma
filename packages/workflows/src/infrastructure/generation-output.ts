import type { ModelSchema } from '@luma/platform';
import { z } from 'zod';

import type {
  CodeStepOutput,
  CodeStepPosition,
  GeneratedDraftOutput,
} from '../domain/draft-generation.js';
import {
  codeStepOutputSchema,
  draftOutputSchema,
} from '../domain/generation-schema.js';
import type { AuthoringVocabulary } from '../domain/vocabulary.js';
import { compileCodeSource } from './code/compiler.js';

const key = z.string().regex(/^[a-z][a-zA-Z0-9_-]{0,79}$/);
const scalar = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const values = z.record(z.string().max(80), scalar);

// Draft content is checked by draft validation, so a readable answer with mistakes can be
// corrected instead of being discarded.
const draftAnswer = z
  .object({
    content: z.record(z.string(), z.unknown()),
    steps: z
      .array(
        z.object({
          stepId: z.string().max(80),
          explanation: z.string().max(2000),
        }),
      )
      .max(64),
    assumptions: z.array(z.string().max(2000)).max(40),
    questions: z
      .array(
        z.object({
          stepId: z.string().max(80).nullable(),
          field: z.string().max(200),
          question: z.string().max(2000),
        }),
      )
      .max(40),
  })
  .strip();

const codeAnswer = z
  .object({
    source: z.string().min(1).max(32_768),
    fields: z
      .record(key, z.enum(['string', 'number', 'boolean', 'null']))
      .refine((items) => Object.keys(items).length <= 64),
    grants: z.array(key).max(16),
    explanation: z.string().max(2000),
    examples: z
      .array(
        z.object({
          name: z.string().max(200),
          input: z.object({
            inputs: values,
            evidence: values,
            steps: z.record(z.string().max(80), values),
          }),
          replies: z.record(z.string().max(80), values).default({}),
          expected: values,
        }),
      )
      .max(5),
  })
  .strip();

/** Output schema and parser for described and refined drafts, limited to installed vocabulary. */
export function draftOutput(
  vocabulary: AuthoringVocabulary,
): ModelSchema<GeneratedDraftOutput> {
  return {
    name: 'workflow_draft',
    jsonSchema: draftOutputSchema(vocabulary),
    parse: (value) => draftAnswer.parse(value),
  };
}

/** Output schema and parser for a Code Step at a position in a draft. */
export function codeStepOutput(
  position: CodeStepPosition,
): ModelSchema<CodeStepOutput> {
  return {
    name: 'code_step',
    jsonSchema: codeStepOutputSchema(
      position.scope,
      position.grantable.map((step) => step.id),
    ),
    parse: (value) => codeAnswer.parse(value),
  };
}

/** Returns why Code Step source can't compile, or null when it compiles. */
export function codeSourceProblem(source: string): string | null {
  try {
    compileCodeSource(source);

    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Code source is invalid';
  }
}
