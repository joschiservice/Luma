import { createHash } from 'node:crypto';

import type { AuditEntry } from '@luma/audit';
import type { TenantContext } from '@luma/identity';

import type { ProcurementStore } from '../application/procurement.js';
import { createProcurementService } from '../application/procurement.js';
import type { PurchaseOrder, Supplier } from '../domain/procurement.js';
import {
  purchaseOrderInputSchema,
  supplierInputSchema,
  transitionInputSchema,
} from './validation.js';

interface State {
  suppliers: Map<string, Supplier>;
  orders: Map<string, PurchaseOrder>;
  commands: Map<string, { digest: string; result: Supplier | PurchaseOrder }>;
  audit: AuditEntry[];
}

/** Creates an isolated deterministic procurement owner for scenario evaluation. */
export function createSimulatedProcurement(options: {
  refreshContext(context: TenantContext): Promise<TenantContext>;
  now(): Date;
  id(): string;
}) {
  const states = new Map<string, State>();
  const queues = new Map<string, Promise<void>>();
  const empty = (): State => ({
    suppliers: new Map(),
    orders: new Map(),
    commands: new Map(),
    audit: [],
  });
  const clone = (state: State): State => ({
    suppliers: new Map(state.suppliers),
    orders: new Map(state.orders),
    commands: new Map(state.commands),
    audit: [...state.audit],
  });
  const store: ProcurementStore = {
    async transaction(tenantId, write, operation) {
      const prior = queues.get(tenantId) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      queues.set(
        tenantId,
        prior.then(() => next),
      );
      await prior;
      const state = clone(states.get(tenantId) ?? empty());
      try {
        const result = await operation({
          suppliers: async () =>
            [...state.suppliers.values()].sort((a, b) =>
              a.name.localeCompare(b.name),
            ),
          orders: async () =>
            [...state.orders.values()].sort((a, b) =>
              b.createdAt.localeCompare(a.createdAt),
            ),
          supplier: async (id) => state.suppliers.get(id) ?? null,
          order: async (id) => state.orders.get(id) ?? null,
          insertSupplier: async (supplier) => {
            state.suppliers.set(supplier.id, supplier);
          },
          insertOrder: async (order) => {
            state.orders.set(order.id, order);
          },
          updateOrder: async (order) => {
            state.orders.set(order.id, order);
          },
          command: async (id) => state.commands.get(id) ?? null,
          saveCommand: async (id, digest, result) => {
            state.commands.set(id, { digest, result });
          },
          audit: async (entry) => {
            state.audit.push(entry);
          },
          history: async (id) =>
            state.audit
              .filter(
                (entry) =>
                  entry.proposalId === id &&
                  entry.eventType.startsWith('purchase_order.'),
              )
              .map((entry) => ({
                id: entry.id,
                commandId: entry.details.commandId,
                occurredAt: entry.occurredAt,
                actorId: entry.actor.id,
                from: (entry.details.from || null) as
                  PurchaseOrder['status'] | null,
                to: entry.details.to as PurchaseOrder['status'],
                revision: Number(entry.details.revision),
                reason: entry.details.reason!,
              }))
              .sort((a, b) => a.revision - b.revision),
        });
        if (write) states.set(tenantId, state);

        return result;
      } finally {
        release();
      }
    },
  };

  return createProcurementService({
    store,
    ...options,
    parseSupplier: (input) => supplierInputSchema.parse(input),
    parseOrder: (input) => purchaseOrderInputSchema.parse(input),
    parseTransition: (input) => transitionInputSchema.parse(input),
    digest: (value) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  });
}
