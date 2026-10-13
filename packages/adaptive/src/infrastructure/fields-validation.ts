import { IdentityError, isPermission } from '@luma/identity';
import { z } from 'zod';

import type {
  CustomField,
  CustomFieldInput,
  CustomFieldValue,
} from '../domain/fields.js';

const adaptiveRecordTypeSchema = z.enum([
  'order',
  'product',
  'supplier',
  'purchase_order',
]);

const customFieldTypeSchema = z.enum([
  'text',
  'number',
  'date',
  'boolean',
  'single_choice',
  'multi_choice',
  'person',
]);

export const customFieldValueSchema = z.union([
  z.string().max(4000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(120)).max(100),
  z.null(),
]);
const label = z
  .object({
    en: z.string().trim().min(1).max(100),
    de: z.string().trim().min(1).max(100),
  })
  .strict();

const customFieldInputSchema = z
  .object({
    recordType: adaptiveRecordTypeSchema,
    key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    label,
    type: customFieldTypeSchema,
    choices: z
      .array(
        z
          .object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), label })
          .strict(),
      )
      .max(100)
      .default([]),
    readPermission: z.string().max(120).default('adaptive.fields.read'),
    writePermission: z.string().max(120).default('adaptive.fields.write'),
  })
  .strict();

export const customFieldSchema = customFieldInputSchema.extend({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  archived: z.boolean(),
  source: z.enum(['luma', 'provider']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** Validates catalog permissions and choice keys before a definition is persisted. */
export function validateCustomField(input: unknown): CustomFieldInput {
  const field = customFieldInputSchema.parse(input);
  if (
    !isPermission(field.readPermission) ||
    !isPermission(field.writePermission)
  )
    throw new IdentityError(
      422,
      'VALIDATION_ERROR',
      'Choose permissions from the permission catalog.',
    );
  const keys = new Set(field.choices.map((c) => c.key));
  if (
    keys.size !== field.choices.length ||
    (field.type === 'single_choice' || field.type === 'multi_choice'
      ? !keys.size
      : keys.size > 0)
  )
    throw new IdentityError(
      422,
      'VALIDATION_ERROR',
      'Choice fields require unique choices; other fields cannot have choices.',
    );

  return field;
}

/** Refuses values of a different type and unrecognized choices; null clears a value. */
export function validateCustomFieldValue(
  field: CustomField,
  input: unknown,
): CustomFieldValue {
  const value = customFieldValueSchema.parse(input);
  if (value === null) return null;
  const choices = new Set(field.choices.map((c) => c.key));
  const valid =
    field.type === 'text'
      ? typeof value === 'string'
      : field.type === 'number'
        ? typeof value === 'number'
        : field.type === 'boolean'
          ? typeof value === 'boolean'
          : field.type === 'date'
            ? typeof value === 'string' &&
              /^\d{4}-\d{2}-\d{2}$/.test(value) &&
              !Number.isNaN(Date.parse(value)) &&
              new Date(value).toISOString().slice(0, 10) === value
            : field.type === 'person'
              ? typeof value === 'string' &&
                z.string().uuid().safeParse(value).success
              : field.type === 'single_choice'
                ? typeof value === 'string' && choices.has(value)
                : Array.isArray(value) &&
                  value.every((v) => choices.has(v)) &&
                  new Set(value).size === value.length;
  if (!valid)
    throw new IdentityError(
      422,
      'VALIDATION_ERROR',
      'The value does not match this field’s type or choices.',
    );

  return value;
}
