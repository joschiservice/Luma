import type { RecordMeta } from '@luma/simulator-core';

import {
  ACTIVE,
  type AssignmentRecord,
  isCount,
  iso,
  type ItemRecord,
  type JtlContext,
  kinds,
  recordId,
  refuse,
  type SupplierRecord,
} from './records.js';
import {
  type JtlSeedItem,
  type JtlSeedSupplier,
  supplierProfiles,
} from './types.js';

/**
 * German standard VAT in percent. The simulated merchant charges it on every sale, and seeded
 * supplier assignments carry it; JTL stores the rate per assignment and per order line.
 */
export const SEED_VAT_RATE = 19;

// JTL's default unit name; the Luma adapter maps it to `each`.
const SEED_UNIT = 'Stück';

type Row = { kind: string; id: string; data: unknown } & RecordMeta;

const isPrice = (value: number) =>
  Number.isFinite(value) && value >= 0 && value < 1e12;

function validate(
  context: JtlContext,
  items: readonly JtlSeedItem[],
  suppliers: readonly JtlSeedSupplier[],
) {
  const supplierIds = suppliers.map((supplier) => recordId(supplier.id));
  if (
    supplierIds.some((id) => !id) ||
    new Set(supplierIds).size !== suppliers.length ||
    suppliers.some(
      (supplier) =>
        !supplier.companyName.trim() ||
        !supplierProfiles.includes(supplier.profile),
    )
  )
    refuse('Invalid supplier');
  const warehouses = new Set(context.config.warehouses.map((w) => w.id));
  const itemIds = items.map((item) => recordId(item.id));
  if (itemIds.some((id) => !id) || new Set(itemIds).size !== items.length)
    refuse('Invalid item ID');
  for (const item of items) {
    if (
      !item.sku.trim() ||
      !/^\d{1,12}(\.\d{1,6})?$/.test(item.price) ||
      Object.entries(item.stock).some(
        ([warehouse, quantity]) =>
          !warehouses.has(warehouse) || !isCount(quantity),
      ) ||
      item.suppliers.some(
        (assignment) =>
          !recordId(assignment.supplierId) || !isPrice(assignment.netPrice),
      ) ||
      new Set(item.suppliers.map((a) => a.supplierId)).size !==
        item.suppliers.length
    )
      refuse(`Invalid item ${item.id}`);
  }
}

/**
 * Inserts catalog items with their warehouse stock, suppliers and item supplier assignments in
 * one bulk write. Items and suppliers must be new; assignments may name suppliers seeded earlier.
 * Assignment IDs continue after the existing assignments.
 */
export async function seedCatalog(
  context: JtlContext,
  items: readonly JtlSeedItem[],
  suppliers: readonly JtlSeedSupplier[],
) {
  validate(context, items, suppliers);
  const { store, now } = context;
  if (
    (
      await store.getMany(
        kinds.item,
        items.map((item) => item.id),
      )
    ).length ||
    (
      await store.getMany(
        kinds.supplier,
        suppliers.map((s) => s.id),
      )
    ).length
  )
    refuse('Catalog record already exists', 409);
  const seeded = new Set(suppliers.map((supplier) => supplier.id));
  const referenced = [
    ...new Set(
      items.flatMap((item) => item.suppliers.map((a) => a.supplierId)),
    ),
  ].filter((id) => !seeded.has(id));
  if (
    (await store.getMany(kinds.supplier, referenced)).length !==
    referenced.length
  )
    refuse('Supplier not found', 404);

  const time = { createdAt: now, updatedAt: now };
  const records: Row[] = [];
  for (const supplier of suppliers) {
    const data: SupplierRecord = {
      id: supplier.id,
      companyName: supplier.companyName,
      supplierNumber: supplier.supplierNumber,
      active: true,
      email: supplier.email,
      city: supplier.city,
      countryIso: supplier.countryIso,
      profile: supplier.profile,
    };
    records.push({
      kind: kinds.supplier,
      id: data.id,
      data,
      key: ACTIVE,
      ...time,
    });
  }
  let assignmentId = await store.count({ kind: kinds.assignment });
  const assignments: Row[] = [];
  for (const item of items) {
    const data: ItemRecord = {
      id: item.id,
      sku: item.sku,
      name: item.name,
      unit: SEED_UNIT,
      price: Number(item.price),
      gtin: item.gtin,
      manufacturer: item.manufacturer,
      active: item.active,
      shopActive: item.shopActive,
      stock: { ...item.stock },
      reserved: 0,
      modified: iso(now),
    };
    records.push({ kind: kinds.item, id: item.id, data, ...time });
    for (const assignment of item.suppliers) {
      const value: AssignmentRecord = {
        id: String(++assignmentId),
        itemId: item.id,
        supplierId: assignment.supplierId,
        netPrice: assignment.netPrice,
        vatRate: SEED_VAT_RATE,
        isDefault: assignment.isDefault,
      };
      assignments.push({
        kind: kinds.assignment,
        id: value.id,
        data: value,
        parent: item.id,
        key: assignment.supplierId,
        ...time,
      });
    }
  }
  await store.putMany([...records, ...assignments]);
  context.notify({
    topic: 'items/seed',
    resource: 'catalog',
    payload: { items: items.length, suppliers: suppliers.length },
  });
}
