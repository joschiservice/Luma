import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ModelSchema } from '#modules/platform/index';
import type { ReasoningSelection } from '#modules/exceptions/application/diagnosis';
const selection = z
  .object({
    hypotheses: z
      .array(
        z
          .object({
            code: z.string().min(1).max(100),
            evidenceRefs: z.array(z.string().min(1).max(512)).min(1).max(100),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export const selectionSchema: ModelSchema<ReasoningSelection> = {
  name: 'diagnosis_hypothesis_selection',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['hypotheses'],
    properties: {
      hypotheses: {
        type: 'array',
        maxItems: 10,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'evidenceRefs'],
          properties: {
            code: { type: 'string' },
            evidenceRefs: {
              type: 'array',
              minItems: 1,
              items: { type: 'string' },
            },
          },
        },
      },
    },
  },
  parse: (value) => selection.parse(value),
};
/** Enforce the local deadline even when a provider ignores cancellation. */
export async function boundedInvestigation<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 5000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Investigation timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const diagnosisTrace = (requestId: string) => ({
  requestId,
  traceId: randomBytes(16).toString('hex'),
  spanId: randomBytes(8).toString('hex'),
});
