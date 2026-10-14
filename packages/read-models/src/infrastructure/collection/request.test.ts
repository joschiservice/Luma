import { describe, expect, it } from 'vitest';

import { collectionCursorContext } from './cursor.js';
import type { CollectionGroupFieldSql } from './group.js';
import {
  collectionContext,
  collectionGrouping,
  collectionScope,
} from './request.js';

const fields: Record<string, CollectionGroupFieldSql> = {
  status: { key: 'o.status', cast: 'text', order: 'asc' },
};

const hash = (scope: unknown) =>
  collectionCursorContext('test-v1', 'tenant', scope);

describe('collection list requests', () => {
  it('binds a group’s page links to its key but not to page sizes', () => {
    const grouped = {
      q: '',
      sort: 'created',
      limit: 50,
      groupLimit: 10,
      group: { field: 'status' },
      cursor: undefined,
    };
    const page = {
      ...grouped,
      limit: 20,
      groupLimit: 5,
      groupKey: 'open',
      cursor: 'abc',
      count: 'exact',
    };
    expect(hash(collectionScope(grouped, 'open'))).toBe(
      hash(collectionScope(page, page.groupKey)),
    );
    expect(hash(collectionScope(grouped, 'open'))).not.toBe(
      hash(collectionScope(grouped, 'closed')),
    );
    expect(hash(collectionScope(grouped))).not.toBe(
      hash(collectionScope({ ...grouped, q: 'x' })),
    );
  });

  it('rejects groupings the list cannot read', () => {
    expect(() =>
      collectionGrouping({ group: { field: 'total' } }, fields),
    ).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => collectionGrouping({ groupKey: 'open' }, fields)).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
    expect(() =>
      collectionGrouping({ group: { field: 'status' }, cursor: 'abc' }, fields),
    ).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(
      collectionGrouping({ group: { field: 'status' }, groupKey: null }, fields)
        .grouped,
    ).toBe(false);
  });

  it('rejects unknown time zones', () => {
    expect(() =>
      collectionContext([], '2026-10-13T00:00:00Z', 'Mars/Olympus', 'u'),
    ).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(
      collectionContext([], '2026-10-13T00:00:00Z', undefined, 'u').timeZone,
    ).toBe('UTC');
  });
});
