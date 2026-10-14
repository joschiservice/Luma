import { randomBytes } from 'node:crypto';

import type { ModelGateway, ModelSchema } from '@luma/platform';
import { ModelGatewayError } from '@luma/platform';
import { z } from 'zod';

import type {
  FactExtractor,
  ModelFact,
} from '../application/document-ports.js';
import type { Representation } from '../domain/documents.js';
import type { FactValue } from '../domain/facts.js';
import { validValue } from '../domain/facts.js';
import { parseDate, parseDecimal } from '../domain/tables.js';

/** Model profile for reading documents attached to messages. Documents are tenant data. */
export const documentExtractionProfile = 'document-extraction';

// Documents contain tenant and personal data. The policy is fixed, never taken from a request.
const dataPolicy = {
  classification: 'sensitive',
  zeroDataRetention: true,
} as const;

/** Characters of document content sent to the model; longer documents are cut. */
const maxInputCharacters = 60_000;

const kinds = ['party', 'reference', 'line', 'date', 'amount'] as const;

const roles = [
  'supplier',
  'customer',
  'purchase_order',
  'order',
  'invoice',
  'delivery_note',
  'delivery',
  'shipping',
  'due',
  'total',
  'other',
] as const;

const text = (max: number) => z.string().max(max).nullable();

const outputFact = z
  .object({
    kind: z.enum(kinds),
    role: z.enum(roles).nullable(),
    name: text(200),
    email: text(320),
    text: text(200),
    sku: text(200),
    description: text(500),
    quantity: text(40),
    unit: text(40),
    unitPrice: text(40),
    currency: text(3),
    date: text(10),
    amount: text(40),
    quote: z.string().min(1).max(1000),
    page: z.number().int().min(1).nullable(),
    sheet: text(200),
    row: z.number().int().min(1).nullable(),
    column: z.number().int().min(1).nullable(),
    confident: z.boolean(),
  })
  .strict();

type OutputFact = z.infer<typeof outputFact>;

const output = z.object({ facts: z.array(outputFact).max(200) }).strict();

const nullable = (type: string) => ({ type: [type, 'null'] });

/** Structured output for document extraction, validated locally. */
const documentExtractionOutput: ModelSchema<z.infer<typeof output>> = {
  name: 'document_facts',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['facts'],
    properties: {
      facts: {
        type: 'array',
        maxItems: 200,
        items: {
          type: 'object',
          additionalProperties: false,
          required: Object.keys(outputFact.shape),
          properties: {
            kind: { type: 'string', enum: [...kinds] },
            role: { type: ['string', 'null'], enum: [...roles, null] },
            name: nullable('string'),
            email: nullable('string'),
            text: nullable('string'),
            sku: nullable('string'),
            description: nullable('string'),
            quantity: nullable('string'),
            unit: nullable('string'),
            unitPrice: nullable('string'),
            currency: nullable('string'),
            date: nullable('string'),
            amount: nullable('string'),
            quote: { type: 'string' },
            page: nullable('integer'),
            sheet: nullable('string'),
            row: nullable('integer'),
            column: nullable('integer'),
            confident: { type: 'boolean' },
          },
        },
      },
    },
  },
  parse: (value) => output.parse(value),
};

const instructions = `You read one business document attached to an email, such as a purchase order, order confirmation, delivery schedule, delivery note or invoice, and list the facts it states.
Rules:
- Use only the document. Never infer, calculate or assume facts it does not state.
- "party": a supplier or customer named in the document (role "supplier" or "customer"), with name and email when shown.
- "reference": a document number with role "purchase_order" (the buyer's order number), "order" (a shop or sales order number), "invoice", "delivery_note" or "other"; text is the number exactly as written.
- "line": an item with sku, description, quantity (decimal with a dot, no thousands separators), unit, unitPrice (decimal with a dot) and currency (ISO code) when stated.
- "date": a date with role "delivery", "shipping", "order", "due" or "other", as YYYY-MM-DD. Set confident to false when the format could be read two ways.
- "amount": a total (role "total") or other amount (role "other") with amount (decimal with a dot) and currency (ISO code).
- quote: copy the exact text from the document that states the fact, character for character. For spreadsheets, copy the cell text and give sheet, row and column of the first cell.
- page: the page number for paged documents; null otherwise.
- confident: false when the wording is ambiguous, conditional, or you had to choose between readings.
Leave fields that do not apply null. Return no facts when the document states none.`;

/** The document as the model sees it, cut to the input limit. */
function documentInput(representation: Representation) {
  let budget = maxInputCharacters;
  let truncated = false;
  if (representation.kind === 'text') {
    const pages: { page: number; text: string }[] = [];
    for (const [index, page] of representation.pages.entries()) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      pages.push({ page: index + 1, text: page.slice(0, budget) });
      truncated ||= page.length > budget;
      budget -= page.length;
    }

    return { input: { kind: 'text', pages }, truncated };
  }
  const sheets: { sheet: string; rows: { row: number; cells: string[] }[] }[] =
    [];
  for (const sheet of representation.sheets) {
    const rows: { row: number; cells: string[] }[] = [];
    for (const [index, cells] of sheet.rows.entries()) {
      if (cells.every((cell) => !cell.trim())) continue;
      const size = cells.reduce((sum, cell) => sum + cell.length + 3, 10);
      if (size > budget) {
        truncated = true;
        break;
      }
      budget -= size;
      rows.push({ row: index + 1, cells });
    }
    sheets.push({ sheet: sheet.name, rows });
    if (truncated) break;
  }

  return { input: { kind: 'sheets', sheets }, truncated };
}

const decimal = (value: string | null) =>
  value === null ? null : (parseDecimal(value)?.value ?? undefined);

/** Builds a fact value from the model's flat answer; null when it is incomplete. */
function factValue(fact: OutputFact): FactValue | null {
  const currency = fact.currency?.trim().toUpperCase() ?? null;
  switch (fact.kind) {
    case 'party':
      return fact.role === 'supplier' || fact.role === 'customer'
        ? {
            kind: 'party',
            role: fact.role,
            name: fact.name?.trim() ?? '',
            email: fact.email?.trim().toLowerCase() || null,
          }
        : null;
    case 'reference':
      return fact.role === 'purchase_order' ||
        fact.role === 'order' ||
        fact.role === 'invoice' ||
        fact.role === 'delivery_note' ||
        fact.role === 'other'
        ? { kind: 'reference', role: fact.role, text: fact.text?.trim() ?? '' }
        : null;
    case 'line': {
      const quantity = decimal(fact.quantity);
      const price = decimal(fact.unitPrice);
      if (quantity === undefined || price === undefined) return null;

      return {
        kind: 'line',
        sku: fact.sku?.trim() || null,
        description: fact.description?.trim() || null,
        quantity,
        unit: fact.unit?.trim() || null,
        unitPrice:
          price !== null && currency ? { amount: price, currency } : null,
      };
    }
    case 'date': {
      const date = fact.date ? parseDate(fact.date) : null;

      return date &&
        (fact.role === 'delivery' ||
          fact.role === 'shipping' ||
          fact.role === 'order' ||
          fact.role === 'due' ||
          fact.role === 'other')
        ? { kind: 'date', role: fact.role, date: date.date }
        : null;
    }
    case 'amount': {
      const amount = decimal(fact.amount);

      return amount &&
        currency &&
        (fact.role === 'total' || fact.role === 'other')
        ? { kind: 'amount', role: fact.role, money: { amount, currency } }
        : null;
    }
  }
}

/**
 * Proposes document facts through the model gateway on the `document-extraction` profile. Only
 * the document's content and file name are sent; failures return a reason without model text.
 */
export function createFactExtractor(options: {
  gateway: ModelGateway | null;
  available: boolean;
  reason: string | null;
}): FactExtractor {
  const available = options.available && !!options.gateway;

  return {
    available,
    reason: available
      ? null
      : (options.reason ??
        'Reading documents automatically is not set up on this server.'),
    async extract(context, input) {
      if (!available || !options.gateway)
        return {
          ok: false,
          reason:
            'Reading documents automatically is not set up on this server. Add facts by hand.',
        };
      const { input: document, truncated } = documentInput(
        input.representation,
      );
      let result;
      try {
        result = await options.gateway.generate(
          {
            requestId: context.requestId,
            traceId: randomBytes(16).toString('hex'),
            spanId: randomBytes(8).toString('hex'),
          },
          {
            profile: documentExtractionProfile,
            dataPolicy: { ...dataPolicy, region: context.dataRegion },
            maxOutputTokens: 8000,
            output: documentExtractionOutput,
            messages: [
              { role: 'system', content: instructions },
              {
                role: 'user',
                content: JSON.stringify({
                  filename: input.filename,
                  ...(truncated ? { note: 'The document was cut.' } : {}),
                  document,
                }),
              },
            ],
          },
        );
      } catch (error) {
        return {
          ok: false,
          reason:
            error instanceof ModelGatewayError && error.code === 'rate_limited'
              ? 'The model was busy. Read the document again later, or add facts by hand.'
              : 'The document could not be read automatically. Add facts by hand.',
        };
      }
      if (!result.output)
        return {
          ok: false,
          reason:
            'The document could not be read automatically. Add facts by hand.',
        };
      const facts: ModelFact[] = [];
      let invalid = 0;
      for (const fact of result.output.facts) {
        const value = factValue(fact);
        if (!value || !validValue(value)) {
          invalid += 1;
          continue;
        }
        facts.push({
          value,
          quote: fact.quote,
          page: fact.page,
          sheet: fact.sheet,
          row: fact.row,
          column: fact.column,
          confident: fact.confident,
        });
      }

      return { ok: true, facts, invalid, model: result.metadata.model };
    },
  };
}
