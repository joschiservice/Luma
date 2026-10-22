import type { ModelGateway } from '@luma/platform';
import { ModelGatewayError } from '@luma/platform';
import { describe, expect, it, vi } from 'vitest';

import { extractFacts, messageText } from '../application/extraction.js';
import { extractionOutput as output } from './extraction-schema.js';

const order = {
  reference: 'PO-1',
  lines: [
    { id: 'a', sku: 'TOTE', description: 'Tote', quantity: 100, unit: 'each' },
  ],
};
const message = {
  subject: 'Re: PO-1',
  body: 'We can deliver 60 pieces on 14 October 2026.',
  from: 'orders@supplier.example',
  receivedAt: '2026-10-01T10:00:00Z',
};
const trace = { traceId: 't', spanId: 's', requestId: 'r' };
let id = 0;

function gateway(output: unknown): ModelGateway {
  return {
    generate: vi.fn(async (_trace, request) => ({
      output: request.output!.parse(output),
      toolCalls: [],
      metadata: {
        adapter: 'bedrock' as const,
        model: 'eu.model',
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: null,
      },
    })) as ModelGateway['generate'],
  };
}

describe('supplier message extraction', () => {
  it('keeps only facts whose quote is in the message and locates their span', async () => {
    const result = await extractFacts({
      tenantId: 'tenant-1',
      dataRegion: 'AU',
      gateway: gateway({
        relatesToOrder: true,
        facts: [
          {
            kind: 'confirmed_quantity',
            lineId: 'a',
            quantity: 60,
            date: null,
            text: null,
            quote: 'deliver 60 pieces',
            confident: true,
          },
          {
            kind: 'promised_date',
            lineId: null,
            quantity: null,
            date: '2026-10-14',
            text: null,
            quote: 'on 14 October 2026',
            confident: true,
          },
          {
            kind: 'shipped',
            lineId: null,
            quantity: null,
            date: null,
            text: null,
            quote: 'shipped yesterday',
            confident: true,
          },
        ],
      }),
      output,
      available: true,
      trace,
      order,
      requestedDeliveryDate: '2026-10-10',
      message,
      id: () => `f${++id}`,
    });
    expect(result.state).toBe('completed');
    if (result.state !== 'completed') return;
    expect(result.discarded).toBe(1);
    const text = messageText(message);
    expect(
      result.facts.map((f) => text.slice(f.span.start, f.span.end)),
    ).toEqual(['deliver 60 pieces', 'on 14 October 2026']);
    expect(result.facts[0]).toMatchObject({
      lineId: 'a',
      quantity: 60,
      confident: true,
    });
  });

  it('marks facts for an unknown line as not confident', async () => {
    const result = await extractFacts({
      tenantId: 'tenant-1',
      dataRegion: 'AU',
      gateway: gateway({
        relatesToOrder: true,
        facts: [
          {
            kind: 'confirmed_quantity',
            lineId: 'other',
            quantity: 60,
            date: null,
            text: null,
            quote: '60 pieces',
            confident: true,
          },
        ],
      }),
      output,
      available: true,
      trace,
      order,
      requestedDeliveryDate: null,
      message,
      id: () => `f${++id}`,
    });
    expect(result.state === 'completed' && result.facts[0]).toMatchObject({
      lineId: null,
      confident: false,
    });
  });

  it('reports an unavailable route without calling a model, and failures without model text', async () => {
    const unavailable = await extractFacts({
      tenantId: 'tenant-1',
      dataRegion: 'AU',
      gateway: null,
      output,
      available: false,
      trace,
      order,
      requestedDeliveryDate: null,
      message,
      id: () => 'x',
    });
    expect(unavailable.state).toBe('unavailable');
    const failing: ModelGateway = {
      generate: vi.fn(async () => {
        throw new ModelGatewayError('rate_limited');
      }),
    };
    const failed = await extractFacts({
      tenantId: 'tenant-1',
      dataRegion: 'AU',
      gateway: failing,
      output,
      available: true,
      trace,
      order,
      requestedDeliveryDate: null,
      message,
      id: () => 'x',
    });
    expect(failed).toEqual({
      state: 'failed',
      reason: expect.stringContaining('busy'),
    });
  });
});
