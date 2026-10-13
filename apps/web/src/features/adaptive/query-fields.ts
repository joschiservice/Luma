import {
  type AdaptiveViewDomain,
  caseQuerySchema,
  customerQuerySchema,
  decisionQuerySchema,
  fulfillmentQuerySchema,
  inventoryQuerySchema,
  orderListQuerySchema,
  productQuerySchema,
} from '@luma/api-contract';
import { z } from 'zod';

const schemas = {
  orders: orderListQuerySchema,
  inventory: inventoryQuerySchema,
  fulfillment: fulfillmentQuerySchema,
  customers: customerQuerySchema,
  products: productQuerySchema,
  procurement: z.object({
    attention: z.enum(['confirmation_overdue', 'delivery_overdue']).optional(),
    supplierId: z.string().uuid().optional(),
    status: z.string().optional(),
  }),
  issues: caseQuerySchema,
  decisions: decisionQuerySchema,
};

/** Offers only predicates actually supported by the owning record query. */
export function filterFields(domain: AdaptiveViewDomain) {
  return Object.keys(schemas[domain].shape).filter(
    (field) =>
      !['cursor', 'limit', 'count', 'sort', 'direction'].includes(field),
  );
}

/** Reads constrained choices from owner schemas instead of maintaining a second vocabulary. */
function enumValues(property: unknown): string[] {
  if (!property || typeof property !== 'object') return [];
  if (
    'const' in property &&
    (typeof property.const === 'string' || typeof property.const === 'boolean')
  )
    return [String(property.const)];
  if ('enum' in property && Array.isArray(property.enum))
    return property.enum.filter(
      (value): value is string => typeof value === 'string',
    );
  if ('anyOf' in property && Array.isArray(property.anyOf))
    return [...new Set(property.anyOf.flatMap(enumValues))];

  return [];
}

/** Reads submitted scalar choices from owner input schemas, including transformed literals. */
export function filterChoices(
  domain: AdaptiveViewDomain,
  field: string,
): string[] {
  const json = z.toJSONSchema(schemas[domain], { io: 'input' });
  const property = json.properties?.[field];

  return enumValues(property);
}

/** Reads supported owner sort keys; custom number and text fields use the adapter's sort. */
export function sortFields(domain: AdaptiveViewDomain): string[] {
  const json = z.toJSONSchema(schemas[domain], { io: 'input' });
  const property = json.properties?.sort;

  return property &&
    typeof property === 'object' &&
    Array.isArray(property.enum)
    ? property.enum.filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
}
