import type { Permission, TenantContext } from '@luma/identity';
import { hasPermission } from '@luma/identity';

import type { RecordKind } from './records.js';

/**
 * The permissions that let a reader see a record kind; any one of them is enough. SKUs are the
 * shared identity of the product catalog and of stock, so either area reveals them.
 */
const recordReadPermissions = {
  order: ['orders.read'],
  fulfillment: ['fulfillment.read'],
  position: ['inventory.read'],
  sku: ['products.read', 'inventory.read'],
  product: ['products.read'],
  issue: ['issues.read'],
} as const satisfies Record<RecordKind, readonly Permission[]>;

/** Reports whether the reader holds a read permission for records of this kind. */
export function canReadRecord(context: TenantContext, kind: RecordKind) {
  return recordReadPermissions[kind].some((permission) =>
    hasPermission(context, permission),
  );
}

/**
 * Names the sections of a read model whose read permission the reader lacks. Responses empty
 * these sections and list them as `hidden`, so clients can show that access is missing instead
 * of presenting the section as empty.
 */
export function hiddenSections<S extends string>(
  context: TenantContext,
  sections: readonly (readonly [section: S, permission: Permission])[],
): S[] {
  return sections.flatMap(([section, permission]) =>
    hasPermission(context, permission) ? [] : [section],
  );
}
