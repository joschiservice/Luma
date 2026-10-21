import { describe, expect, it } from 'vitest';

import { caseQuerySchema } from './cases.js';
import { collectionQueryIssue } from './collection-catalog.js';
import {
  decisionsCatalog,
  inboxCatalog,
  issuesCatalog,
} from './collection-catalogs.js';
import { decisionQuerySchema } from './decisions.js';
import { threadQuerySchema } from './messaging.js';

describe('work queue catalogs', () => {
  it('opens all unresolved issues by default in both the list API and the catalog', () => {
    expect(caseQuerySchema.parse({}).view).toBe('active');
    expect(issuesCatalog.segments[0]).toBe('active');
  });

  it('declare only sorts the list APIs accept', () => {
    for (const [catalog, schema] of [
      [issuesCatalog, caseQuerySchema],
      [decisionsCatalog, decisionQuerySchema],
      [inboxCatalog, threadQuerySchema],
    ] as const) {
      expect(catalog.defaultSort).not.toBeNull();
      for (const field of catalog.fields.filter((item) => item.sort))
        expect(
          schema.shape.sort.safeParse(field.id).success,
          `${catalog.domain}.${field.id}`,
        ).toBe(true);
    }
  });

  it('never offer message text as an inbox condition', () => {
    for (const field of ['subject', 'correspondent'])
      expect(
        collectionQueryIssue(inboxCatalog, {
          where: {
            match: 'all',
            conditions: [{ field, op: 'contains', value: 'invoice' }],
          },
        }),
      ).toBe('Condition 1: This field cannot be filtered.');
  });

  it('accept the owner pill’s conditions and group the board by state', () => {
    for (const catalog of [issuesCatalog, decisionsCatalog, inboxCatalog])
      expect(
        collectionQueryIssue(catalog, {
          where: {
            match: 'all',
            conditions: [
              { field: 'owner', op: 'any_of', value: [{ dynamic: 'me' }] },
              { field: 'owner', op: 'empty' },
            ],
          },
        }),
      ).toBeNull();
    expect(
      collectionQueryIssue(issuesCatalog, { group: { field: 'state' } }),
    ).toBeNull();
    expect(
      collectionQueryIssue(issuesCatalog, {
        where: {
          match: 'all',
          conditions: [
            { field: 'freshness', op: 'any_of', value: ['current'] },
          ],
        },
      }),
    ).toBe('Condition 1: This value is not one of the field’s options.');
    expect(
      collectionQueryIssue(decisionsCatalog, { group: { field: 'title' } }),
    ).toBe('This field cannot be grouped.');
  });
});
