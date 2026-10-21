import { expect, it } from 'vitest';

import { workflowActorSchema } from './workflows.js';

it('requires accountable operator and grant references for agent provenance', () => {
  expect(
    workflowActorSchema.safeParse({
      kind: 'agent',
      id: 'agent-1',
      operatorId: 'operator-1',
      grantId: 'delegation-1',
    }).success,
  ).toBe(true);
  expect(
    workflowActorSchema.safeParse({ kind: 'agent', id: 'agent-1' }).success,
  ).toBe(false);
  expect(
    workflowActorSchema.safeParse({
      kind: 'agent',
      id: 'agent-1',
      operatorId: 'operator-1',
      grantId: '',
    }).success,
  ).toBe(false);
});
