import type { CollectionCondition } from '../../application/collections.js';
import { catalogFields, catalogStatuses } from '../../application/products.js';
import type { CollectionGroupFieldSql } from '../collection/group.js';
import { collectionQueryError } from '../collection/parameters.js';
import {
  SourceConditions,
  type SourceFieldSql,
} from '../collection/source-scope.js';
import {
  type CollectionCompileContext,
  type CollectionFieldMap,
  conditionValues,
} from '../collection/where.js';

// SKU fragments read the compared SKU row `o`; listing fragments read one catalog row `c`.

/** Listing facts each catalog source reports separately; blank text is not reported. */
const listingFields: Readonly<Record<string, SourceFieldSql>> = {
  status: { type: 'enum', sql: 'c.product_status' },
  published: { type: 'boolean', sql: 'c.published' },
  vendor: { type: 'text', sql: "NULLIF(btrim(c.vendor),'')" },
  price: {
    type: 'money',
    sql: 'c.price_amount',
    currency: 'c.price_currency',
  },
  barcode: { type: 'text', sql: "NULLIF(btrim(c.barcode),'')" },
  bundle: { type: 'boolean', sql: 'c.requires_components' },
};

/** Matches SKUs whose `column` (a uuid array) shares, or does not share, the listed IDs. */
function overlap(
  column: string,
  condition: CollectionCondition,
  context: CollectionCompileContext,
) {
  if (condition.op === 'empty') return `cardinality(${column})=0`;
  if (condition.op === 'not_empty') return `cardinality(${column})>0`;
  const values = context.parameters.bind(
    conditionValues(condition, 'uuid', context),
    'uuid[]',
  );
  if (condition.op === 'any_of') return `${column} && ${values}`;
  if (condition.op === 'none_of') return `NOT (${column} && ${values})`;
  throw collectionQueryError('This field does not support this operator');
}

/**
 * Products catalog fields as SQL. Listing fields compile into aggregates collected by
 * `scoped`, which the SKU aggregate must select; the rest read the compared SKU row.
 */
export function productCollectionFields(
  scoped: SourceConditions,
): CollectionFieldMap {
  return {
    ...scoped.fields(listingFields),
    updated: { type: 'date', sql: 'o.updated_at' },
    differences: { type: 'tags', sql: 'o.differences' },
    listings: {
      type: 'reference',
      predicate: (condition, context) =>
        overlap('o.connections', condition, context),
    },
    missing: {
      type: 'reference',
      predicate: (condition, context) =>
        overlap('o.gap_ids', condition, context),
    },
  };
}

/** Collects listing conditions over catalog rows `c`, scoped by their connection. */
export function productSourceConditions() {
  return new SourceConditions('c.connection_id');
}

/**
 * Groupable Products fields. A SKU counts in the group of every vendor, status and differing
 * field its listings report; SKUs without one form the last group.
 */
export const productGroupFields: Readonly<
  Record<string, CollectionGroupFieldSql>
> = {
  vendor: {
    keys: 'SELECT unnest(o.vendors) AS key',
    cast: 'text',
    order: 'asc',
  },
  status: {
    keys: 'SELECT unnest(o.statuses) AS key',
    cast: 'text',
    order: { options: catalogStatuses },
  },
  differences: {
    keys: 'SELECT unnest(o.differences) AS key',
    cast: 'text',
    order: { options: catalogFields },
  },
};
