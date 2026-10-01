import type { ModelSchema } from '@luma/platform';
import { z } from 'zod';

import {
  extractable,
  type ExtractionOutput,
} from '../application/extraction.js';

const factSchema = z
  .object({
    kind: z.enum(extractable),
    lineId: z.string().max(100).nullable(),
    quantity: z.number().finite().min(0).max(1_000_000_000).nullable(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    text: z.string().max(300).nullable(),
    quote: z.string().min(1).max(600),
    confident: z.boolean(),
  })
  .strict();

const outputSchema = z
  .object({
    relatesToOrder: z.boolean(),
    facts: z.array(factSchema).max(40),
  })
  .strict();

const nullable = (type: string) => ({ type: [type, 'null'] });

/** Structured output for supplier-message extraction, validated locally. */
export const extractionOutput: ModelSchema<ExtractionOutput> = {
  name: 'supplier_commitments',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['relatesToOrder', 'facts'],
    properties: {
      relatesToOrder: { type: 'boolean' },
      facts: {
        type: 'array',
        maxItems: 40,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'kind',
            'lineId',
            'quantity',
            'date',
            'text',
            'quote',
            'confident',
          ],
          properties: {
            kind: { type: 'string', enum: [...extractable] },
            lineId: nullable('string'),
            quantity: nullable('number'),
            date: nullable('string'),
            text: nullable('string'),
            quote: { type: 'string' },
            confident: { type: 'boolean' },
          },
        },
      },
    },
  },
  parse: (value) => outputSchema.parse(value),
};
