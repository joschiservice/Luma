import type {
  ModelGateway,
  ModelSchema,
  ModelUsage,
  TraceContext,
} from '@luma/platform';
import { ModelGatewayError } from '@luma/platform';

import type { CommitmentKind } from '../domain/commitments.js';
import type { PurchaseOrder } from '../domain/procurement.js';

/** Model profile for reading supplier messages. Messages are tenant data. */
export const supplierExtractionProfile = 'supplier-extraction';

// Supplier messages contain tenant and personal data. The policy is fixed after authorization.
const dataPolicy = {
  classification: 'sensitive',
  region: 'EU',
  zeroDataRetention: true,
} as const;

export const extractable = [
  'confirmed_quantity',
  'promised_date',
  'shipped',
  'condition',
] as const satisfies readonly CommitmentKind[];

/** What the model returns: statements with the exact quote that states each one. */
export interface ExtractionOutput {
  relatesToOrder: boolean;
  facts: {
    kind: ExtractableKind;
    lineId: string | null;
    quantity: number | null;
    date: string | null;
    text: string | null;
    quote: string;
    confident: boolean;
  }[];
}

type ExtractableKind = (typeof extractable)[number];

/** A fact found in a message, located by its exact quote. */
interface ExtractedFact {
  id: string;
  kind: ExtractableKind;
  lineId: string | null;
  quantity: number | null;
  date: string | null;
  text: string | null;
  span: { start: number; end: number };
  confident: boolean;
}

export type ExtractionResult =
  | {
      state: 'completed';
      relatesToOrder: boolean;
      facts: ExtractedFact[];
      /** Facts dropped because their quote is not in the message. */
      discarded: number;
      model: string;
      usage: ModelUsage;
    }
  | {
      state: 'unavailable' | 'failed';
      reason: string;
    };

/** The text that spans index into: subject, a blank line, then the body. */
export function messageText(message: { subject: string; body: string }) {
  return `${message.subject}\n\n${message.body}`;
}

const instructions = `You read one message from a supplier about a purchase order and list only what the supplier states.
Rules:
- Use only the message. Never infer, calculate or assume facts the supplier did not state.
- "confirmed_quantity": the quantity the supplier confirms or can deliver for a line. A refusal is quantity 0.
- "promised_date": the delivery date the supplier promises (YYYY-MM-DD). Resolve relative dates only when the message states its date; otherwise set confident to false.
- "shipped": the supplier says goods were dispatched (date when stated). This is not receipt.
- "condition": a price change, surcharge, minimum quantity or other condition, summarized in text.
- lineId: the order line's ID from the list, matched by SKU or description; null for the whole order or when unclear.
- quote: copy the exact words from the message that state the fact, character for character.
- confident: false when the wording is ambiguous, conditional or you had to choose between readings.
- relatesToOrder: false when the message is not about this order.
Return no facts when the message states none.`;

/**
 * Asks the configured EU model to list supplier statements with exact quotes. Facts whose quote
 * is not found in the message are dropped, so every kept fact cites the message it came from.
 * Model failures are returned, never thrown, and contain no model text.
 */
export async function extractFacts(input: {
  gateway: ModelGateway | null;
  /** Validates the model's structured answer. */
  output: ModelSchema<ExtractionOutput>;
  available: boolean;
  trace: TraceContext;
  order: Pick<PurchaseOrder, 'reference' | 'lines'>;
  requestedDeliveryDate: string | null;
  message: { subject: string; body: string; from: string; receivedAt: string };
  id(): string;
  signal?: AbortSignal;
}): Promise<ExtractionResult> {
  if (!input.gateway || !input.available)
    return {
      state: 'unavailable',
      reason:
        'Reading supplier messages automatically is not set up on this server. Record what the supplier said by hand.',
    };
  const text = messageText(input.message);
  let result;
  try {
    result = await input.gateway.generate(input.trace, {
      profile: supplierExtractionProfile,
      dataPolicy,
      maxOutputTokens: 2000,
      output: input.output,
      ...(input.signal ? { signal: input.signal } : {}),
      messages: [
        { role: 'system', content: instructions },
        {
          role: 'user',
          content: JSON.stringify({
            order: {
              reference: input.order.reference,
              requestedDeliveryDate: input.requestedDeliveryDate,
              lines: input.order.lines.map((line) => ({
                lineId: line.id,
                sku: line.sku,
                description: line.description,
                quantity: line.quantity,
                unit: line.unit,
              })),
            },
            message: {
              from: input.message.from,
              receivedAt: input.message.receivedAt,
              text,
            },
          }),
        },
      ],
    });
  } catch (error) {
    return {
      state: 'failed',
      reason:
        error instanceof ModelGatewayError && error.code === 'rate_limited'
          ? 'The model is busy. Try reading the message again in a minute.'
          : 'The message could not be read automatically. Try again, or record what the supplier said by hand.',
    };
  }
  if (!result.output)
    return {
      state: 'failed',
      reason: 'The message could not be read automatically.',
    };
  const lineIds = new Set(input.order.lines.map((line) => line.id));
  const facts: ExtractedFact[] = [];
  let discarded = 0;
  for (const fact of result.output.facts) {
    const start = text.indexOf(fact.quote);
    if (start < 0) {
      discarded += 1;
      continue;
    }
    const lineId = fact.lineId && lineIds.has(fact.lineId) ? fact.lineId : null;
    facts.push({
      id: input.id(),
      kind: fact.kind,
      lineId,
      quantity: fact.kind === 'confirmed_quantity' ? fact.quantity : null,
      date:
        fact.kind === 'promised_date' || fact.kind === 'shipped'
          ? fact.date
          : null,
      text: fact.kind === 'condition' ? (fact.text ?? fact.quote) : null,
      span: { start, end: start + fact.quote.length },
      confident:
        fact.confident &&
        (fact.lineId === null || lineId !== null) &&
        (fact.kind !== 'confirmed_quantity' || fact.quantity !== null) &&
        (fact.kind !== 'promised_date' || fact.date !== null),
    });
  }

  return {
    state: 'completed',
    relatesToOrder: result.output.relatesToOrder,
    facts,
    discarded,
    model: result.metadata.model,
    usage: {
      inputTokens: result.metadata.inputTokens,
      outputTokens: result.metadata.outputTokens,
      costUsd: result.metadata.costUsd,
    },
  };
}
