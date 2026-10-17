import type { TenantContext } from '@luma/identity';
import {
  hasPermission,
  isPermission,
  requireChangesAllowed,
  requirePermission,
  requireTenant,
} from '@luma/identity';
import { conflict, forbidden, invalid, notFound } from '@luma/platform';

import type {
  AdaptiveRecordType,
  CustomField,
  CustomFieldInput,
  CustomFieldRecord,
  CustomFieldRecordValue,
  CustomFieldValue,
} from '../domain/fields.js';

const invalidInput = () => invalid('Custom field input is invalid.');

function assertUuid(value: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw invalidInput();
}

function assertRecordType(value: string) {
  if (
    !['order', 'product', 'supplier', 'purchase_order', 'customer'].includes(
      value,
    )
  )
    throw invalidInput();
}

function assertBounded(value: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw invalidInput();
}

function assertRevision(value: number, min: number) {
  assertBounded(value, min, Number.MAX_SAFE_INTEGER);
}

interface CustomFieldFilter {
  fieldId: string;
  operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'is_empty';
  value?: CustomFieldValue | undefined;
}

export interface CustomFieldQuery {
  recordType: AdaptiveRecordType;
  filters?: CustomFieldFilter[] | undefined;
  sort?: { fieldId: string; direction: 'asc' | 'desc' } | undefined;
  groupBy?: string | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
}

export interface CustomFieldQueryResult {
  recordIds: string[];
  groups: { value: CustomFieldValue; count: number }[];
  hasMore: boolean;
}

export interface CustomFieldEvent {
  id: string;
  fieldId: string;
  recordId: string | null;
  actorId: string;
  occurredAt: string;
  before: unknown;
  after: unknown;
  kind: 'created' | 'updated' | 'archived' | 'restored' | 'value_changed';
}

export interface FieldsTransaction {
  effect(
    id: string,
  ): Promise<{ digest: string; result: CustomFieldRecordValue } | null>;
  saveEffect(
    id: string,
    digest: string,
    result: CustomFieldRecordValue,
  ): Promise<void>;
  command(id: string): Promise<{ digest: string; result: CustomField } | null>;
  saveCommand(id: string, digest: string, result: CustomField): Promise<void>;
  list(
    recordType: AdaptiveRecordType,
    archived?: boolean,
  ): Promise<CustomField[]>;
  get(id: string): Promise<CustomField | null>;
  save(field: CustomField): Promise<void>;
  hasValues(id: string): Promise<boolean>;
  recordExists(type: AdaptiveRecordType, id: string): Promise<boolean>;
  personExists(id: string): Promise<boolean>;
  values(
    type: AdaptiveRecordType,
    id: string,
  ): Promise<CustomFieldRecordValue[]>;
  /** Values of several records of one type; records without values are absent. */
  valuesMany(
    type: AdaptiveRecordType,
    ids: readonly string[],
  ): Promise<(CustomFieldRecordValue & { recordId: string })[]>;
  setValue(
    type: AdaptiveRecordType,
    id: string,
    value: CustomFieldRecordValue,
  ): Promise<void>;
  event(event: CustomFieldEvent): Promise<void>;
  history(
    fieldId: string,
    recordId: string | null,
  ): Promise<CustomFieldEvent[]>;
  query(
    input: CustomFieldQuery,
    definitions: CustomField[],
  ): Promise<CustomFieldQueryResult>;
}

export interface FieldsStore {
  /** Serializes definition and value writes in the tenant and commits audit with them. */
  transaction<T>(
    tenantId: string,
    write: boolean,
    run: (tx: FieldsTransaction) => Promise<T>,
  ): Promise<T>;
}

/** Owns typed Luma fields, record-scoped values, fresh authorization and transactional history. */
export function createFieldsService(deps: {
  store: FieldsStore;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  released(context: TenantContext): Promise<boolean>;
  parseField(input: unknown): CustomFieldInput;
  parseValue(field: CustomField, value: unknown): CustomFieldValue;
  id(): string;
  now(): Date;
}) {
  async function authorize(
    context: TenantContext,
    permission:
      | 'adaptive.fields.read'
      | 'adaptive.fields.write'
      | 'adaptive.fields.manage',
  ) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    if (fresh.actor.id !== context.actor.id)
      throw forbidden('Sign in again to continue.');
    requirePermission(fresh, permission);
    if (permission !== 'adaptive.fields.read') requireChangesAllowed(fresh);
    if (!(await deps.released(fresh)))
      throw forbidden('Custom fields are not enabled for this workspace.');

    return fresh;
  }

  function canRead(context: TenantContext, field: CustomField) {
    return (
      isPermission(field.readPermission) &&
      hasPermission(context, field.readPermission)
    );
  }

  function fieldPermission(
    context: TenantContext,
    field: CustomField,
    write: boolean,
  ) {
    const permission = write ? field.writePermission : field.readPermission;
    if (!isPermission(permission))
      throw forbidden('This field permission is unavailable.');
    requirePermission(context, permission);
    if (write && (field.archived || field.source !== 'luma'))
      throw conflict('Archived and provider-observed fields cannot be edited.');
  }

  function scope(context: TenantContext, type: AdaptiveRecordType) {
    requirePermission(
      context,
      type === 'order'
        ? 'orders.read'
        : type === 'product'
          ? 'products.read'
          : type === 'customer'
            ? 'customers.read'
            : 'procurement.read',
    );
  }

  async function record(
    tx: FieldsTransaction,
    type: AdaptiveRecordType,
    id: string,
  ) {
    assertRecordType(type);
    assertUuid(id);
    if (!(await tx.recordExists(type, id))) throw notFound('Record not found.');
  }

  async function get(tx: FieldsTransaction, id: string) {
    assertUuid(id);
    const field = await tx.get(id);
    if (!field) throw notFound('Field not found.');

    return field;
  }

  function event(
    context: TenantContext,
    fieldId: string,
    kind: CustomFieldEvent['kind'],
    before: unknown,
    after: unknown,
    recordId: string | null = null,
  ): CustomFieldEvent {
    return {
      id: deps.id(),
      fieldId,
      kind,
      before,
      after,
      recordId,
      actorId: context.actor.id,
      occurredAt: deps.now().toISOString(),
    };
  }

  return {
    async list(
      context: TenantContext,
      recordType: AdaptiveRecordType,
      includeArchived = false,
    ): Promise<CustomField[]> {
      context = await authorize(context, 'adaptive.fields.read');
      assertRecordType(recordType);
      scope(context, recordType);

      return deps.store.transaction(context.tenantId, false, async (tx) =>
        (await tx.list(recordType, includeArchived)).filter((f) =>
          canRead(context, f),
        ),
      );
    },
    async create(
      context: TenantContext,
      input: CustomFieldInput & { commandId: string },
    ): Promise<CustomField> {
      context = await authorize(context, 'adaptive.fields.manage');
      const { commandId, ...body } = input;
      assertUuid(commandId);
      const definition = deps.parseField(body);
      scope(context, definition.recordType);
      const digest = JSON.stringify({ actorId: context.actor.id, definition });
      // Prevent defining a permission gate the administrator cannot themselves pass.
      const permissionProbe = {
        ...definition,
        id: deps.id(),
        revision: 1,
        archived: false,
        source: 'luma' as const,
        createdAt: deps.now().toISOString(),
        updatedAt: deps.now().toISOString(),
      };
      fieldPermission(context, permissionProbe, false);
      fieldPermission(context, permissionProbe, true);

      return deps.store.transaction(context.tenantId, true, async (tx) => {
        const prior = await tx.command(commandId);
        if (prior) {
          if (prior.digest !== digest)
            throw conflict(
              'This request ID was already used for different fields.',
            );

          return prior.result;
        }
        if (
          (await tx.list(definition.recordType, true)).some(
            (f) => f.key === definition.key,
          )
        )
          throw conflict('A field with this key already exists.');
        await tx.save(permissionProbe);
        await tx.event(
          event(context, permissionProbe.id, 'created', null, permissionProbe),
        );
        await tx.saveCommand(commandId, digest, permissionProbe);

        return permissionProbe;
      });
    },
    async update(
      context: TenantContext,
      id: string,
      input: CustomFieldInput & { revision: number },
    ): Promise<CustomField> {
      context = await authorize(context, 'adaptive.fields.manage');
      const { revision, ...body } = input;
      assertRevision(revision, 1);
      const definition = deps.parseField(body);

      return deps.store.transaction(context.tenantId, true, async (tx) => {
        const before = await get(tx, id);
        scope(context, before.recordType);
        fieldPermission(context, before, false);
        fieldPermission(context, before, true);
        if (before.revision !== revision)
          throw conflict('This field changed. Reload before saving.');
        if (
          definition.recordType !== before.recordType ||
          definition.key !== before.key
        )
          throw invalid('A field’s record type and key cannot change.');
        if (await tx.hasValues(id)) {
          if (
            definition.type !== before.type ||
            before.choices.some(
              (c) => !definition.choices.some((next) => next.key === c.key),
            )
          )
            throw conflict(
              'Clear existing values before changing the field type or removing choices.',
            );
        }
        const after = {
          ...before,
          ...definition,
          revision: revision + 1,
          updatedAt: deps.now().toISOString(),
        };
        fieldPermission(context, after, false);
        fieldPermission(context, after, true);
        await tx.save(after);
        await tx.event(event(context, id, 'updated', before, after));

        return after;
      });
    },
    async archive(
      context: TenantContext,
      id: string,
      revision: number,
    ): Promise<CustomField> {
      context = await authorize(context, 'adaptive.fields.manage');
      assertRevision(revision, 1);

      return deps.store.transaction(context.tenantId, true, async (tx) => {
        const before = await get(tx, id);
        scope(context, before.recordType);
        fieldPermission(context, before, false);
        if (before.revision !== revision)
          throw conflict('This field changed. Reload before archiving.');
        const after = {
          ...before,
          archived: true,
          revision: revision + 1,
          updatedAt: deps.now().toISOString(),
        };
        await tx.save(after);
        await tx.event(event(context, id, 'archived', before, after));

        return after;
      });
    },
    /** Restores an archived Luma definition while preserving its existing values and history. */
    async restore(
      context: TenantContext,
      id: string,
      revision: number,
    ): Promise<CustomField> {
      context = await authorize(context, 'adaptive.fields.manage');
      assertRevision(revision, 1);

      return deps.store.transaction(context.tenantId, true, async (tx) => {
        const before = await get(tx, id);
        scope(context, before.recordType);
        fieldPermission(context, before, false);
        if (!before.archived || before.source !== 'luma')
          throw conflict('Only archived Luma fields can be restored.');
        if (before.revision !== revision)
          throw conflict('This field changed. Reload before restoring.');
        const after = {
          ...before,
          archived: false,
          revision: revision + 1,
          updatedAt: deps.now().toISOString(),
        };
        fieldPermission(context, after, true);
        await tx.save(after);
        await tx.event(event(context, id, 'restored', before, after));

        return after;
      });
    },
    /**
     * Reads the reader's permitted fields and their values for up to 100 records of one type,
     * as list pages show them in columns. Records the reader cannot see return no values.
     */
    async readMany(
      context: TenantContext,
      type: AdaptiveRecordType,
      recordIds: readonly string[],
    ) {
      context = await authorize(context, 'adaptive.fields.read');
      scope(context, type);
      assertRecordType(type);
      assertBounded(recordIds.length, 1, 100);
      for (const id of recordIds) assertUuid(id);

      return deps.store.transaction(context.tenantId, false, async (tx) => {
        const fields = (await tx.list(type)).filter((f) => canRead(context, f));
        const ids = new Set(fields.map((f) => f.id));

        return {
          fields,
          values: (await tx.valuesMany(type, [...new Set(recordIds)])).filter(
            (value) => ids.has(value.fieldId),
          ),
        };
      });
    },
    async readValues(
      context: TenantContext,
      type: AdaptiveRecordType,
      recordId: string,
    ): Promise<CustomFieldRecord> {
      context = await authorize(context, 'adaptive.fields.read');
      scope(context, type);

      return deps.store.transaction(context.tenantId, false, async (tx) => {
        await record(tx, type, recordId);
        const fields = (await tx.list(type)).filter((f) => canRead(context, f));
        const ids = new Set(fields.map((f) => f.id));

        return {
          fields,
          values: (await tx.values(type, recordId)).filter((v) =>
            ids.has(v.fieldId),
          ),
        };
      });
    },
    async writeValues(
      context: TenantContext,
      type: AdaptiveRecordType,
      recordId: string,
      input: { fieldId: string; value: CustomFieldValue; revision: number }[],
    ): Promise<CustomFieldRecord> {
      context = await authorize(context, 'adaptive.fields.write');
      scope(context, type);
      assertBounded(input.length, 1, 50);
      for (const change of input) {
        assertUuid(change.fieldId);
        assertRevision(change.revision, 0);
      }
      if (new Set(input.map((v) => v.fieldId)).size !== input.length)
        throw invalid('Each field may be changed once per request.');

      return deps.store.transaction(context.tenantId, true, async (tx) => {
        await record(tx, type, recordId);
        const prior = await tx.values(type, recordId);
        for (const change of input) {
          const field = await get(tx, change.fieldId);
          if (field.recordType !== type)
            throw invalid('This field belongs to another record type.');
          fieldPermission(context, field, false);
          fieldPermission(context, field, true);
          const value = deps.parseValue(field, change.value);
          const before = prior.find((v) => v.fieldId === field.id);
          if ((before?.revision ?? 0) !== change.revision)
            throw conflict('A field value changed. Reload before saving.');
          if (
            field.type === 'person' &&
            typeof value === 'string' &&
            !(await tx.personExists(value))
          )
            throw invalid('Choose an active person in this workspace.');
          const after = {
            fieldId: field.id,
            value,
            revision: change.revision + 1,
            updatedAt: deps.now().toISOString(),
            updatedBy: context.actor.id,
          };
          await tx.setValue(type, recordId, after);
          await tx.event(
            event(
              context,
              field.id,
              'value_changed',
              before ?? null,
              after,
              recordId,
            ),
          );
        }
        const fields = (await tx.list(type)).filter((f) => canRead(context, f));
        const ids = new Set(fields.map((f) => f.id));

        return {
          fields,
          values: (await tx.values(type, recordId)).filter((v) =>
            ids.has(v.fieldId),
          ),
        };
      });
    },
    /** Executes only through a composed admission effect; pins the reviewed field/value revisions and deduplicates its receipt. */
    async writeGovernedValue(
      context: TenantContext,
      input: {
        commandId: string;
        recordType: AdaptiveRecordType;
        recordId: string;
        fieldId: string;
        value: CustomFieldValue;
        revision: number;
        fieldRevision: number;
      },
    ): Promise<CustomFieldRecordValue> {
      context = await authorize(context, 'adaptive.fields.write');
      scope(context, input.recordType);
      assertUuid(input.fieldId);
      assertRevision(input.revision, 0);
      assertRevision(input.fieldRevision, 1);
      if (!input.commandId || input.commandId.length > 200)
        throw invalidInput();
      const digest = JSON.stringify({
        actorId: context.actor.id,
        recordType: input.recordType,
        recordId: input.recordId,
        fieldId: input.fieldId,
        value: input.value,
        revision: input.revision,
        fieldRevision: input.fieldRevision,
      });

      return deps.store.transaction(context.tenantId, true, async (tx) => {
        await record(tx, input.recordType, input.recordId);
        const field = await get(tx, input.fieldId);
        fieldPermission(context, field, false);
        fieldPermission(context, field, true);
        if (field.recordType !== input.recordType) throw invalidInput();
        const prior = await tx.effect(input.commandId);
        if (prior) {
          if (prior.digest !== digest)
            throw conflict('This effect ID was used for another field change.');

          return prior.result;
        }
        if (field.revision !== input.fieldRevision)
          throw conflict('The field definition changed after review.');
        const value = deps.parseValue(field, input.value);
        const before = (await tx.values(input.recordType, input.recordId)).find(
          (v) => v.fieldId === field.id,
        );
        if ((before?.revision ?? 0) !== input.revision)
          throw conflict('The field value changed after review.');
        if (
          field.type === 'person' &&
          typeof value === 'string' &&
          !(await tx.personExists(value))
        )
          throw invalid('Choose an active person in this workspace.');
        const after = {
          fieldId: field.id,
          value,
          revision: input.revision + 1,
          updatedAt: deps.now().toISOString(),
          updatedBy: context.actor.id,
        };
        await tx.setValue(input.recordType, input.recordId, after);
        await tx.event(
          event(
            context,
            field.id,
            'value_changed',
            before ?? null,
            after,
            input.recordId,
          ),
        );
        await tx.saveEffect(input.commandId, digest, after);

        return after;
      });
    },
    /** Reads selected permission-visible fields as workflow scalars; multi-choice reads test one choice explicitly. */
    async readWorkflowInputs(
      context: TenantContext,
      type: AdaptiveRecordType,
      recordId: string,
      selections: { fieldId: string; choiceKey?: string }[],
    ): Promise<Record<string, string | number | boolean | null>> {
      context = await authorize(context, 'adaptive.fields.read');
      scope(context, type);
      assertBounded(selections.length, 1, 50);

      return deps.store.transaction(context.tenantId, false, async (tx) => {
        await record(tx, type, recordId);
        const values = await tx.values(type, recordId);
        const result: Record<string, string | number | boolean | null> = {};
        for (const selection of selections) {
          const field = await get(tx, selection.fieldId);
          if (field.recordType !== type || field.archived)
            throw invalid('Choose an active field for this record type.');
          fieldPermission(context, field, false);
          const value =
            values.find((v) => v.fieldId === field.id)?.value ?? null;
          if (field.type === 'multi_choice') {
            if (
              !selection.choiceKey ||
              !field.choices.some((c) => c.key === selection.choiceKey)
            )
              throw invalid(
                'Choose which multiple-choice option the workflow reads.',
              );
            result[`${field.key}.${selection.choiceKey}`] =
              value === null
                ? null
                : Array.isArray(value) && value.includes(selection.choiceKey);
          } else {
            if (selection.choiceKey || Array.isArray(value))
              throw invalid('This field does not have multiple choices.');
            result[field.key] = value;
          }
        }

        return result;
      });
    },
    async history(
      context: TenantContext,
      id: string,
      recordId: string | null = null,
    ): Promise<CustomFieldEvent[]> {
      context = await authorize(context, 'adaptive.fields.read');
      if (recordId) assertUuid(recordId);

      return deps.store.transaction(context.tenantId, false, async (tx) => {
        const field = await get(tx, id);
        scope(context, field.recordType);
        fieldPermission(context, field, false);
        if (recordId) await record(tx, field.recordType, recordId);

        return tx.history(id, recordId);
      });
    },
    async query(
      context: TenantContext,
      input: CustomFieldQuery,
    ): Promise<CustomFieldQueryResult> {
      context = await authorize(context, 'adaptive.fields.read');
      assertRecordType(input.recordType);
      scope(context, input.recordType);
      assertBounded(input.limit ?? 50, 1, 100);
      assertBounded(input.offset ?? 0, 0, 100000);
      if ((input.filters?.length ?? 0) > 20)
        throw invalid('Use at most 20 field filters.');

      return deps.store.transaction(context.tenantId, false, async (tx) => {
        const fields = await tx.list(input.recordType);
        const ids = [
          ...(input.filters ?? []).map((f) => f.fieldId),
          ...(input.sort ? [input.sort.fieldId] : []),
          ...(input.groupBy ? [input.groupBy] : []),
        ];
        for (const id of ids) {
          assertUuid(id);
          const field = fields.find((f) => f.id === id);
          if (!field)
            throw invalid('Choose an active field for this record type.');
          fieldPermission(context, field, false);
        }
        for (const filter of input.filters ?? []) {
          const field = fields.find((f) => f.id === filter.fieldId)!;
          if (
            ![
              'eq',
              'ne',
              'gt',
              'gte',
              'lt',
              'lte',
              'contains',
              'is_empty',
            ].includes(filter.operator)
          )
            throw invalidInput();
          if (filter.operator !== 'is_empty')
            deps.parseValue(
              field,
              filter.operator === 'contains' && field.type === 'multi_choice'
                ? [filter.value]
                : filter.value,
            );
          if (
            ['gt', 'gte', 'lt', 'lte'].includes(filter.operator) &&
            field.type !== 'number' &&
            field.type !== 'date'
          )
            throw invalid('Ranges require a number or date field.');
          if (filter.operator === 'contains' && field.type !== 'multi_choice')
            throw invalid('Contains requires a multiple choice field.');
        }
        if (input.sort && !['asc', 'desc'].includes(input.sort.direction))
          throw invalidInput();

        return tx.query(input, fields);
      });
    },
  };
}

export type AdaptiveFields = ReturnType<typeof createFieldsService>;
