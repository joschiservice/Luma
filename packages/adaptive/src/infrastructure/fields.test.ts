import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@luma/identity';
import {
  builtInMembership,
  makeTenantContext,
  PermissionSet,
} from '@luma/identity';
import { describe, expect, it } from 'vitest';

import type { CustomFieldEvent, FieldsStore } from '../application/fields.js';
import { createFieldsService } from '../application/fields.js';
import type {
  CustomField,
  CustomFieldInput,
  CustomFieldRecordValue,
} from '../domain/fields.js';
import { customFieldQuerySql } from './fields.js';
import {
  validateCustomField,
  validateCustomFieldValue,
} from './fields-validation.js';

const tenantId = randomUUID(),
  actorId = randomUUID(),
  recordId = randomUUID();
const context = makeTenantContext(
  { userId: actorId, sessionId: randomUUID() },
  {
    id: tenantId,
    name: 'Shop',
    slug: 'shop',
    dataRegion: 'AU',
    status: 'active',
  },
  builtInMembership(
    { id: randomUUID(), organizationId: tenantId, userId: actorId },
    'owner',
  ),
  randomUUID(),
);
const definition = (
  type: CustomFieldInput['type'] = 'text',
): CustomFieldInput => ({
  recordType: 'order',
  key: 'artwork',
  label: { en: 'Artwork', de: 'Druckvorlage' },
  type,
  choices: [],
  readPermission: 'adaptive.fields.read',
  writePermission: 'adaptive.fields.write',
});

function fixture() {
  const fields = new Map<string, CustomField>(),
    values = new Map<string, CustomFieldRecordValue>(),
    events: CustomFieldEvent[] = [],
    commands = new Map<string, { digest: string; result: CustomField }>();
  let fresh: TenantContext = context,
    released = true,
    person = true;
  const store: FieldsStore = {
    transaction: async (tenant, _write, run) =>
      run({
        list: async (type, archived = false) =>
          [...fields.values()].filter(
            (f) =>
              tenant === tenantId &&
              f.recordType === type &&
              (archived || !f.archived),
          ),
        get: async (id) =>
          tenant === tenantId ? (fields.get(id) ?? null) : null,
        effect: async () => null,
        saveEffect: async () => {},
        command: async (id) => commands.get(id) ?? null,
        saveCommand: async (id, digest, result) => {
          commands.set(id, { digest, result });
        },
        save: async (field) => {
          fields.set(field.id, field);
        },
        hasValues: async (id) => values.get(id)?.value != null,
        recordExists: async (_type, id) =>
          tenant === tenantId && id === recordId,
        personExists: async () => person,
        values: async () => [...values.values()],
        valuesMany: async (_type, ids) =>
          ids.includes(recordId)
            ? [...values.values()].map((value) => ({ ...value, recordId }))
            : [],
        setValue: async (_type, _id, value) => {
          values.set(value.fieldId, value);
        },
        event: async (e) => {
          events.push(e);
        },
        history: async (id, r) =>
          events.filter((e) => e.fieldId === id && e.recordId === r),
        query: async () => ({
          recordIds: [recordId],
          groups: [],
          hasMore: false,
        }),
      }),
  };
  const service = createFieldsService({
    store,
    parseField: validateCustomField,
    parseValue: validateCustomFieldValue,
    refreshContext: async () => fresh,
    released: async () => released,
    id: randomUUID,
    now: () => new Date('2026-10-13T00:00:00Z'),
  });

  return {
    service,
    fields,
    values,
    events,
    create: (type: CustomFieldInput['type'] = 'text') =>
      service.create(context, { ...definition(type), commandId: randomUUID() }),
    refresh: (next: TenantContext) => {
      fresh = next;
    },
    release: () => {
      released = false;
    },
    personMissing: () => {
      person = false;
    },
  };
}

describe('typed custom fields', () => {
  it('accepts every supported type and refuses invalid dates, choices, numbers and people', () => {
    const base = {
      ...definition(),
      id: randomUUID(),
      revision: 1,
      archived: false,
      source: 'luma' as const,
      createdAt: '2026-10-13T00:00:00Z',
      updatedAt: '2026-10-13T00:00:00Z',
    };
    for (const [type, value] of [
      ['text', 'abc'],
      ['number', 1.25],
      ['date', '2024-02-29'],
      ['boolean', true],
      ['person', randomUUID()],
      ['single_choice', 'approved'],
      ['multi_choice', ['approved']],
    ] as const) {
      const field = {
        ...base,
        type,
        choices: type.includes('choice')
          ? [{ key: 'approved', label: { en: 'Approved', de: 'Freigegeben' } }]
          : [],
      };
      expect(
        validateCustomFieldValue(
          field,
          Array.isArray(value) ? [...value] : value,
        ),
      ).toEqual(value);
      expect(validateCustomFieldValue(field, null)).toBeNull();
    }
    for (const [type, value] of [
      ['date', '2025-02-29'],
      ['number', '3'],
      ['number', Infinity],
      ['boolean', 'yes'],
      ['person', 'outsider'],
      ['single_choice', 'unknown'],
      ['multi_choice', ['approved', 'approved']],
    ] as const)
      expect(() =>
        validateCustomFieldValue(
          {
            ...base,
            type,
            choices: [
              { key: 'approved', label: { en: 'Approved', de: 'Freigegeben' } },
            ],
          },
          value,
        ),
      ).toThrow();
  });
  it('audits creation and edits, supports create replay, and refuses stale revisions and type changes with values', async () => {
    const f = fixture(),
      input = { ...definition(), commandId: randomUUID() };
    const field = await f.service.create(context, input);
    expect(await f.service.create(context, input)).toEqual(field);
    expect(f.events).toHaveLength(1);
    await expect(
      f.service.create(context, {
        ...input,
        label: { en: 'Other', de: 'Andere' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const result = await f.service.writeValues(context, 'order', recordId, [
      { fieldId: field.id, value: 'approved', revision: 0 },
    ]);
    expect(result.values[0]?.revision).toBe(1);
    expect(f.events[1]).toMatchObject({
      actorId,
      kind: 'value_changed',
      recordId,
      before: null,
      after: { value: 'approved' },
    });
    await expect(
      f.service.writeValues(context, 'order', recordId, [
        { fieldId: field.id, value: 'stale', revision: 0 },
      ]),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      f.service.update(context, field.id, {
        ...definition('number'),
        revision: 1,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await f.service.writeValues(context, 'order', recordId, [
      { fieldId: field.id, value: null, revision: 1 },
    ]);
    expect(
      await f.service.update(context, field.id, {
        ...definition('number'),
        revision: 1,
      }),
    ).toMatchObject({ type: 'number', revision: 2 });
    await f.service.archive(context, field.id, 2);
    expect(await f.service.list(context, 'order')).toEqual([]);
    expect(await f.service.list(context, 'order', true)).toHaveLength(1);
  });
  it('refreshes permissions, hides protected values, refuses read-only observations, and honors rollout', async () => {
    const f = fixture(),
      field = await f.create();
    await f.service.writeValues(context, 'order', recordId, [
      { fieldId: field.id, value: 'secret', revision: 0 },
    ]);
    f.fields.set(field.id, {
      ...field,
      readPermission: 'activity.read_restricted',
    });
    const limited = {
      ...context,
      permissions: new PermissionSet([
        'adaptive.fields.read',
        'adaptive.fields.write',
        'orders.read',
      ]),
    };
    f.refresh(limited);
    expect(await f.service.readValues(context, 'order', recordId)).toEqual({
      fields: [],
      values: [],
    });
    await expect(
      f.service.writeValues(context, 'order', recordId, [
        { fieldId: field.id, value: 'x', revision: 1 },
      ]),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    f.refresh(context);
    f.fields.set(field.id, { ...field, source: 'provider' });
    await expect(
      f.service.writeValues(context, 'order', recordId, [
        { fieldId: field.id, value: 'x', revision: 1 },
      ]),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    f.release();
    await expect(f.service.list(context, 'order')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
  it('requires a matching record and active tenant person and refuses support writes', async () => {
    const f = fixture(),
      field = await f.create('person');
    f.personMissing();
    await expect(
      f.service.writeValues(context, 'order', recordId, [
        { fieldId: field.id, value: randomUUID(), revision: 0 },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      f.service.readValues(context, 'order', randomUUID()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    f.refresh({
      ...context,
      supportView: {
        id: randomUUID(),
        mode: 'consent',
        expiresAt: '2026-10-14T00:00:00Z',
      },
    });
    await expect(f.create()).rejects.toMatchObject({ code: 'READ_ONLY' });
  });
  it('rejects unknown permission gates and non-choice fields with choices', () => {
    expect(() =>
      validateCustomField({
        ...definition(),
        readPermission: 'private.anything',
      }),
    ).toThrow('catalog');
    expect(() =>
      validateCustomField({
        ...definition(),
        choices: [{ key: 'one', label: { en: 'One', de: 'Eins' } }],
      }),
    ).toThrow('choices');
  });
  it('validates filter types and refuses querying inaccessible fields', async () => {
    const f = fixture(),
      field = await f.create();
    await expect(
      f.service.query(context, {
        recordType: 'order',
        filters: [{ fieldId: field.id, operator: 'gt', value: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    f.fields.set(field.id, {
      ...field,
      readPermission: 'activity.read_restricted',
    });
    f.refresh({
      ...context,
      permissions: new PermissionSet(['adaptive.fields.read', 'orders.read']),
    });
    await expect(
      f.service.query(context, {
        recordType: 'order',
        sort: { fieldId: field.id, direction: 'asc' },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('uses parameterized indexed predicates before sorting and pagination', async () => {
    const f = fixture(),
      field = await f.create('number');
    const query = customFieldQuerySql(
      tenantId,
      {
        recordType: 'order',
        filters: [{ fieldId: field.id, operator: 'gte', value: 20 }],
        sort: { fieldId: field.id, direction: 'desc' },
        groupBy: field.id,
        limit: 50,
      },
      [field],
    );
    expect(query.rows.sql).toContain('v.number_value >= $4');
    expect(query.rows.sql).toContain('NULLS LAST');
    expect(query.rows.values).toContain(20);
    expect(query.groups?.sql).toContain('GROUP BY');
  });
});
