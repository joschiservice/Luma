import type { AssistantAnswer, AssistantCitation } from '@luma/api-contract';
import { describe, expect, it } from 'vitest';

import {
  type Exchange,
  historyFor,
  parseAnswer,
  stepsSummary,
  suggestionsFor,
} from './presentation';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

const citation = (
  kind: AssistantCitation['kind'],
  recordId: string,
): AssistantCitation => ({
  kind,
  id: recordId,
  label: 'Order #1001',
  detail: null,
  sources: [],
  observedAt: null,
  sourceUpdatedAt: null,
});

describe('parseAnswer', () => {
  it('reads paragraphs, lists, bold, code and numbered citations', () => {
    const citations = [citation('order', id), citation('issue', other)];
    const blocks = parseAnswer(
      `Two orders are **late**:\n\n- #1001 [[order:${id}]]\n- issue \`stuck\` [[issue:${other}]]\n  still open\n\n1. First\n2. Second [[order:${id}]]`,
      citations,
    );

    expect(blocks).toEqual([
      {
        type: 'paragraph',
        lines: [
          [
            { type: 'text', text: 'Two orders are ' },
            { type: 'strong', text: 'late' },
            { type: 'text', text: ':' },
          ],
        ],
      },
      {
        type: 'list',
        ordered: false,
        items: [
          [
            { type: 'text', text: '#1001 ' },
            { type: 'citation', citation: citations[0], number: 1 },
          ],
          [
            { type: 'text', text: 'issue ' },
            { type: 'code', text: 'stuck' },
            { type: 'text', text: ' ' },
            { type: 'citation', citation: citations[1], number: 2 },
            { type: 'text', text: ' still open' },
          ],
        ],
      },
      {
        type: 'list',
        ordered: true,
        items: [
          [{ type: 'text', text: 'First' }],
          [
            { type: 'text', text: 'Second ' },
            { type: 'citation', citation: citations[0], number: 1 },
          ],
        ],
      },
    ]);
  });

  it('keeps markup as text and drops markers without a citation', () => {
    expect(
      parseAnswer(`<img src=x onerror=alert(1)> [[order:${other}]]`, []),
    ).toEqual([
      {
        type: 'paragraph',
        lines: [[{ type: 'text', text: '<img src=x onerror=alert(1)> ' }]],
      },
    ]);
  });
});

describe('historyFor', () => {
  it('sends answered turns only, within the request limits', () => {
    const answer = { content: 'A'.repeat(9000) } as AssistantAnswer;
    const exchanges: Exchange[] = [
      { id: '1', question: 'Q1', state: { status: 'answered', answer } },
      { id: '2', question: 'Q2', state: { status: 'failed', message: 'x' } },
      ...Array.from({ length: 12 }, (_, index): Exchange => ({
        id: `n${index}`,
        question: `N${index}`,
        state: {
          status: 'answered',
          answer: { content: 'ok' } as AssistantAnswer,
        },
      })),
    ];

    const history = historyFor(exchanges);

    expect(history).toHaveLength(20);
    expect(history[0]).toEqual({ role: 'user', content: 'N2' });
    expect(history.some((turn) => turn.content === 'Q2')).toBe(false);
    expect(historyFor(exchanges.slice(0, 1))[1]!.content).toHaveLength(8000);
  });
});

it('summarizes reads and suggests questions for readable records', () => {
  expect(
    stepsSummary([
      { tool: 'search_orders', summary: '', outcome: 'ok', records: 3 },
      { tool: 'get_order', summary: '', outcome: 'failed', records: 0 },
      { tool: 'limit', summary: '', outcome: 'skipped', records: 0 },
    ]),
  ).toBe('2 reads · 3 records · a read failed');
  expect(suggestionsFor(['return', 'order'])).toEqual([
    'Which orders from last week are still unfulfilled?',
    'Which returns are waiting for a refund?',
  ]);
});
