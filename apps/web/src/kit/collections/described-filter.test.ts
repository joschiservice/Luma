import { describe, expect, it } from 'vitest';

import { proposedConditions } from './described-filter';

const draft = (patch: object) => ({
  status: 'ready' as const,
  explanation: '',
  warnings: [],
  preview: null,
  query: {
    version: 2 as const,
    domain: 'orders' as const,
    state: {
      segment: null,
      where: {
        match: 'all' as const,
        conditions: [
          { field: 'status', op: 'any_of' as const, value: ['open'] },
        ],
      },
      sort: null,
      group: null,
      layout: 'table' as const,
      density: 'comfortable' as const,
      columns: [],
      properties: [],
      preview: false,
    },
    metrics: [],
    charts: [],
    actions: [],
  },
  ...patch,
});

describe('described filters', () => {
  it('proposes the draft’s conditions for this list only', () => {
    expect(proposedConditions(draft({}), 'orders').conditions).toHaveLength(1);
    const other = proposedConditions(draft({}), 'customers');
    expect(other.conditions).toEqual([]);
    expect(other.reason).toBeTruthy();
  });

  it('explains instead of proposing when the request needs clarification', () => {
    expect(
      proposedConditions(
        draft({
          status: 'needs_clarification',
          query: null,
          explanation: 'Which warehouse?',
        }),
        'orders',
      ),
    ).toEqual({ conditions: [], reason: 'Which warehouse?' });
  });
});
