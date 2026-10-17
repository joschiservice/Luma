import type { EffectIntent, EffectRegistry } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { hasPermission } from '@luma/identity';
import { canonicalJson, conflict, invalid } from '@luma/platform';

import type {
  AdaptiveRecordType,
  CustomField,
  CustomFieldValue,
} from '../domain/fields.js';
import type { AdaptiveFields } from './fields.js';

/** Names the governed write capability for one supported record type. */
export const fieldWriteCapability = (type: AdaptiveRecordType) =>
  `adaptive.${type}.field.write`;

/** Recognizes only the custom field capabilities owned by Adaptive. */
export const isFieldWriteCapability = (capability: string) =>
  ['order', 'product', 'supplier', 'purchase_order'].some(
    (type) => capability === `adaptive.${type}.field.write`,
  );

export const fieldVerificationVersion = 'adaptive.field-value/1';

/** Resolves only Luma-owned field changes; execution still applies policy and approval before dispatch. */
export function createFieldsEffects(
  fields: AdaptiveFields,
  parseValue: (field: CustomField, value: unknown) => CustomFieldValue,
  now: () => Date,
): EffectRegistry {
  async function target(context: TenantContext, intent: EffectIntent) {
    if (
      intent.tenantId !== context.tenantId ||
      intent.connectionId !== context.tenantId ||
      !isFieldWriteCapability(intent.capability) ||
      intent.capabilityVersion !== '1' ||
      (intent.target.kind !== 'order' &&
        intent.target.kind !== 'product' &&
        intent.target.kind !== 'supplier' &&
        intent.target.kind !== 'purchase_order')
    )
      return null;
    const recordType: AdaptiveRecordType = intent.target.kind;
    if (intent.capability !== fieldWriteCapability(recordType)) return null;
    const record = await fields.readValues(
      context,
      recordType,
      intent.target.id,
    );
    const field = record.fields.find((f) => f.id === intent.parameters.fieldId);
    if (
      !field ||
      field.source !== 'luma' ||
      !hasPermission(context, 'adaptive.fields.write')
    )
      return null;
    if (
      typeof intent.parameters.valueJson !== 'string' ||
      typeof intent.parameters.revision !== 'number' ||
      typeof intent.parameters.fieldRevision !== 'number' ||
      !Number.isInteger(intent.parameters.revision) ||
      intent.parameters.revision < 0 ||
      !Number.isInteger(intent.parameters.fieldRevision) ||
      intent.parameters.fieldRevision < 1
    )
      throw invalid('The field change is invalid.');
    const value = parseValue(field, JSON.parse(intent.parameters.valueJson));
    const current = record.values.find((v) => v.fieldId === field.id);

    return { recordType, field, current, value };
  }

  return {
    resolve: async (context, intent) => {
      const selected = await target(context, intent);
      if (!selected) return null;

      return {
        capability: fieldWriteCapability(selected.recordType),
        version: '1',
        minimumRisk: 'medium',
        permission: selected.field.writePermission,
        dispatchIdentity: 'luma:adaptive-fields:1',
        mechanism: 'api',
        executor: { kind: 'service', id: 'luma-adaptive-fields' },
        checkPreconditions: async (action) => {
          const current = await target(context, action);

          return (
            !!current &&
            current.field.revision === action.parameters.fieldRevision &&
            (current.current?.revision ?? 0) === action.parameters.revision
          );
        },
        execute: async (action, idempotencyKey) => {
          const current = await target(context, action);
          if (!current) throw conflict('The field is unavailable.');
          await fields.writeGovernedValue(context, {
            commandId: idempotencyKey,
            recordType: current.recordType,
            recordId: action.target.id,
            fieldId: current.field.id,
            value: current.value,
            revision: Number(action.parameters.revision),
            fieldRevision: Number(action.parameters.fieldRevision),
          });

          return {
            evidenceRefs: [current.field.id],
            providerRequestId: idempotencyKey,
          };
        },
        verify: async (action) => {
          const current = await target(context, action);
          const observedAt = now().toISOString();

          return {
            outcome: !current
              ? 'inconclusive'
              : current.field.revision === action.parameters.fieldRevision &&
                  current.current?.revision ===
                    Number(action.parameters.revision) + 1 &&
                  canonicalJson(current.current.value) ===
                    canonicalJson(current.value)
                ? 'passed'
                : 'failed',
            observationRefs: current?.current ? [current.field.id] : [],
            observedAt,
            evaluatorVersion: fieldVerificationVersion,
          };
        },
      };
    },
  };
}
