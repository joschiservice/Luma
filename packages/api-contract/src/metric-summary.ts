import { z } from 'zod';

import { apiErrorSchema } from './common.js';
import { metricRequestSchema, metricResponseSchema } from './metrics.js';
import {
  operationalMetricRequestSchema,
  operationalMetricResponseSchema,
} from './operational-metrics.js';

const timestamp = z.string().datetime({ offset: true });

export const metricSummaryRequestSchema = z
  .object({
    parts: z
      .array(
        z.discriminatedUnion('kind', [
          z
            .object({ kind: z.literal('orders'), request: metricRequestSchema })
            .strict(),
          z
            .object({
              kind: z.literal('operational'),
              request: operationalMetricRequestSchema,
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(4),
  })
  .strict();

const failedPartSchema = z.object({
  kind: z.enum(['orders', 'operational']),
  status: z.number().int().min(400).max(599),
  error: apiErrorSchema,
});

const metricSummaryPartSchema = z.union([
  z.object({
    kind: z.literal('orders'),
    status: z.literal(200),
    body: metricResponseSchema,
  }),
  z.object({
    kind: z.literal('operational'),
    status: z.literal(200),
    body: operationalMetricResponseSchema,
  }),
  failedPartSchema,
]);

export const metricSummaryResponseSchema = z.object({
  readAt: timestamp,
  nextRefreshAt: timestamp
    .nullable()
    .describe('Earliest refresh boundary across the parts that were read.'),
  parts: z.array(metricSummaryPartSchema),
});

export type MetricSummaryRequest = z.input<typeof metricSummaryRequestSchema>;

export type MetricSummaryResponse = z.infer<typeof metricSummaryResponseSchema>;
