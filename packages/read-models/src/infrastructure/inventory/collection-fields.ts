import type { CollectionCondition } from '../../application/collections.js';
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

// Position fragments read the position row `o`; source fragments read one source row `c`.

/** A quantity every source reports separately; `lowest` ignores sources without one. */
const quantity = (column: string): SourceFieldSql => ({
  type: 'number',
  sql: `c.${column}`,
  lowest: `min(c.${column})`,
});

/** Facts each source of a position reports separately. Missing values stay unknown. */
const sourceFields: Readonly<Record<string, SourceFieldSql>> = {
  available: quantity('available'),
  onHand: quantity('on_hand'),
  reserved: quantity('reserved'),
  incoming: quantity('incoming'),
  belowSafetyStock: {
    type: 'boolean',
    sql: 'CASE WHEN c.available IS NULL OR c.safety_stock IS NULL THEN NULL ELSE c.available<c.safety_stock END',
  },
  availabilityBasis: { type: 'enum', sql: 'c.availability_basis' },
  tracked: { type: 'boolean', sql: 'c.tracked' },
  itemActive: { type: 'boolean', sql: 'c.item_active' },
  locationActive: { type: 'boolean', sql: 'c.location_active' },
  lastRead: { type: 'date', sql: 'c.observed_at' },
};

/**
 * True while the detector lets provider sync close the position's available-stock gap: a
 * wait reconfirmed within five minutes whose deadline has not passed, on a position whose
 * sources still report different available quantities. Detail shows the same wait.
 */
const awaitingSync = `('available'=ANY(o.differences) AND EXISTS(SELECT 1 FROM exception_pending_sync w
 WHERE w.tenant_id=$1 AND w.subject_kind='sku' AND w.subject_id=o.sku_id::text AND w.scope->>0=o.location_id::text
 AND w.wait_until>now() AND w.evaluated_at>now()-interval '5 minutes'))`;

/** Matches positions with a source among, or none among, the listed connections. */
function sourcePredicate(
  condition: CollectionCondition,
  context: CollectionCompileContext,
) {
  const values = context.parameters.bind(
    conditionValues(condition, 'uuid', context),
    'uuid[]',
  );
  if (condition.op === 'any_of') return `o.connections && ${values}`;
  if (condition.op === 'none_of') return `NOT (o.connections && ${values})`;
  throw collectionQueryError('This field does not support this operator');
}

/**
 * Inventory catalog fields as SQL. Source fields compile into aggregates collected by
 * `scoped`, which the position aggregate must select; the rest read the position row.
 */
export function inventoryCollectionFields(
  scoped: SourceConditions,
): CollectionFieldMap {
  return {
    ...scoped.fields(sourceFields),
    location: { type: 'reference', sql: 'o.location_id', cast: 'uuid' },
    source: { type: 'reference', predicate: sourcePredicate },
    differences: { type: 'tags', sql: 'o.differences' },
    sync: { type: 'boolean', sql: awaitingSync },
  };
}

/** Collects source conditions over source rows `c`, scoped by their connection. */
export function inventorySourceConditions() {
  return new SourceConditions('c.connection_id');
}

/**
 * Groupable Inventory fields, keyed by canonical ID. A position counts in the group of each of
 * its sources; a SKU group holds that SKU at every location.
 */
export const inventoryGroupFields: Readonly<
  Record<string, CollectionGroupFieldSql>
> = {
  location: { key: 'o.location_id', cast: 'uuid', order: 'asc' },
  sku: { key: 'o.sku_id', cast: 'uuid', order: 'asc' },
  source: {
    keys: 'SELECT unnest(o.connections) AS key',
    cast: 'uuid',
    order: 'asc',
  },
};
