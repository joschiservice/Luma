import {
  type AssignmentRecord,
  iso,
  type ItemRecord,
  type JtlContext,
  kinds,
  refuse,
} from './records.js';
import type { JtlCommand } from './types.js';

/** Changes purchasing-system terms and advances the product version for the next incremental read. */
export async function setSupplierTerms(
  context: JtlContext,
  input: Extract<JtlCommand, { kind: 'supplier-terms' }>,
) {
  const item = await context.store.get<ItemRecord>(kinds.item, input.itemId);
  const assignments = (
    await context.store.page<AssignmentRecord>({
      kind: kinds.assignment,
      parent: input.itemId,
      key: input.supplierId,
      limit: 2,
    })
  ).items;
  if (!item || assignments.length !== 1)
    refuse('Supplier assignment not found', 404);
  if (
    input.netPrice !== undefined &&
    (!Number.isFinite(input.netPrice) || input.netPrice < 0)
  )
    refuse('Invalid purchase price');
  for (const value of [
    input.packSize,
    input.minimumQuantity,
    input.leadTimeDays,
  ])
    if (value != null && (!Number.isFinite(value) || value < 0))
      refuse('Invalid purchasing term');
  const assignment = assignments[0]!;
  const updated = { ...assignment.data };
  if (input.netPrice !== undefined) updated.netPrice = input.netPrice;
  for (const key of [
    'supplierArticleNumber',
    'packSize',
    'minimumQuantity',
    'leadTimeDays',
  ] as const) {
    if (key in input) {
      if (input[key] === null) Reflect.deleteProperty(updated, key);
      else Object.assign(updated, { [key]: input[key] });
    }
  }
  await context.store.put(kinds.assignment, assignment.id, updated, {
    updatedAt: context.now,
    parent: input.itemId,
    key: input.supplierId,
  });
  const product = {
    ...item.data,
    modified: iso(Math.max(context.now, Date.parse(item.data.modified) + 1)),
    purchasingSuppliers: (item.data.purchasingSuppliers ?? []).map((value) =>
      value.supplierId === input.supplierId
        ? {
            ...value,
            netPrice: updated.netPrice,
            leadTimeDays: updated.leadTimeDays,
            ...(updated.supplierArticleNumber
              ? { supplierArticleNumber: updated.supplierArticleNumber }
              : { supplierArticleNumber: undefined }),
          }
        : value,
    ),
  };
  await context.store.put(kinds.item, item.id, product, {
    updatedAt: context.now,
  });

  return { id: assignment.id };
}
