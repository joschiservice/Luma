import { createHash } from 'node:crypto';

import { generateCatalog, merchantProfile } from '@luma/simulator-commerce';

import { erpOf } from './erp.mjs';

/**
 * Workflows the demo turns on. Each starts a run when detection opens its kind of case, or when
 * an owner reports a follow-up such as an overdue supplier order.
 */
const demoCaseWorkflows = [
  'shopify-stock-correction',
  'shopify-hold-release',
  'connection-sync-check',
  'supplier-follow-up',
  'refund-follow-up',
  'payment-follow-up',
];

/** Supplier answers the demo spreads over its suppliers, so purchase orders meet each one. */
const answerProfiles = ['full', 'partial', 'delayed', 'short', 'silent'];

/** Faster windows for the demo: stuck after 20 minutes, holds overdue after 30, short follow-ups. */
export const demoDetection = (configuration) => ({
  configuration: {
    ...configuration,
    version: `${configuration.version}-simulator-demo`,
    thresholds: { ...configuration.thresholds, stuckSeconds: 1200 },
  },
  holdOverdueSeconds: 1800,
  // Follow-ups: 15 minutes for the supplier, refunds after 8 hours, payments after 1 hour.
  followUps: {
    supplierWaitSeconds: 900,
    refundWaitMs: 8 * 3_600_000,
    paymentWaitMs: 3_600_000,
  },
});

const stableId = (value) => {
  const hex = createHash('sha256').update(value).digest('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/**
 * The most-demanded SKUs the demo sets stock rules for, with their suppliers and the answer
 * profile each supplier gets. Deterministic for a run's profile and seed.
 */
function demoPlan(manifest, rules = 8) {
  const stock = manifest.simulator?.stock;
  if (!stock) return { variants: [], suppliers: [] };
  const catalog = generateCatalog(merchantProfile(stock.profile), stock.seed);
  const variants = [...catalog.variants]
    .sort((a, b) => b.popularity - a.popularity || Number(a.id) - Number(b.id))
    .filter((variant) => variant.id !== manifest.simulator.inventory.erpItem)
    .slice(0, rules);
  const supplierIds = [...new Set(variants.map((item) => item.supplierId))];
  const suppliers = supplierIds.map((id, index) => ({
    ...catalog.suppliers.find((item) => item.id === id),
    answers: answerProfiles[index % answerProfiles.length],
  }));

  return { variants, suppliers };
}

/** Sets each demo supplier's answer profile in the simulated ERP. Safe to repeat. */
export async function configureDemoSuppliers(call, manifest) {
  if (!manifest.simulator?.demo?.workflows) return;
  for (const supplier of demoPlan(manifest).suppliers)
    await call(`runs/${manifest.simulator.runId}/control`, {
      action: 'command',
      instance: erpOf(manifest).name,
      command: {
        kind: 'supplier-profile',
        supplierId: supplier.id,
        profile: supplier.answers,
      },
    });
}

/**
 * The inbox rules the demo adds to the simulated mailbox: one per demo supplier's order address,
 * linked to its Procurement supplier, and catch-alls for every other supplier and for customers.
 * All simulated suppliers write from `supplier.example` and customers from `customer.example`.
 * @param {{ id: string, email: string }[]} suppliers demo suppliers with their simulator IDs
 * @param {(simulatorId: string) => string | undefined} supplierId Luma supplier of a simulator supplier
 */
function demoInboxRules(runId, suppliers, supplierId) {
  return [
    ...suppliers.flatMap((supplier) => {
      const id = supplierId(supplier.id);

      return id
        ? [
            {
              id: stableId(`${runId}:inbox-rule:supplier:${supplier.id}`),
              kind: 'sender_address',
              value: supplier.email,
              party: { kind: 'supplier', supplierId: id },
            },
          ]
        : [];
    }),
    {
      id: stableId(`${runId}:inbox-rule:suppliers`),
      kind: 'sender_domain',
      value: 'supplier.example',
      party: { kind: 'other' },
    },
    {
      id: stableId(`${runId}:inbox-rule:customers`),
      kind: 'sender_domain',
      value: 'customer.example',
      party: { kind: 'customer' },
    },
  ];
}

/**
 * Configures the simulated merchant's workflows once their records are imported, as a merchant
 * would: case workflows on, suppliers linked to the ERP, stock rules for the most-demanded
 * linked SKUs and, when the workspace has the operations inbox and a simulated mailbox, inbox
 * rules for supplier and customer mail. It acts as the workspace owner, so the admin who signs in approves the changes.
 * Two rules start just above current stock so a proposal follows the next fresh stock read.
 * Each pass does what is still missing and is safe to repeat.
 */
export function createWorkflowDemo({ application, manifest, owner }) {
  if (!manifest.simulator?.demo?.workflows)
    return { pass: async () => ({ workflows: 0, suppliers: 0, rules: 0 }) };
  const plan = demoPlan(manifest);
  const runId = manifest.simulator.runId;
  const erp = erpOf(manifest);
  const done = {
    workflows: new Set(),
    suppliers: new Map(),
    rules: new Set(),
    inbox: new Set(),
  };
  const conflict = (error) => [404, 409, 503].includes(error?.statusCode);

  async function workflows(context) {
    for (const id of demoCaseWorkflows) {
      if (done.workflows.has(id)) continue;
      const detail = await application.caseWorkflows.detail(context, id);
      if (!detail.activations.some((item) => item.active))
        try {
          await application.caseWorkflows.activate(context, id, {
            id: stableId(`${runId}:workflow:${id}`),
            version: detail.versions[0].version,
            reviewedDigest: detail.versions[0].digest,
            policyVersion: detail.policyVersion,
          });
        } catch (error) {
          // Not ready yet, for example while the worker starts; the next pass retries.
          if (conflict(error)) continue;
          throw error;
        }
      done.workflows.add(id);
    }
  }

  async function suppliers(context) {
    for (const supplier of plan.suppliers) {
      if (done.suppliers.has(supplier.id)) continue;
      const id = stableId(`${runId}:supplier:${supplier.id}`);
      let current = await application.procurement.supplier(context, id);
      current ??= await application.procurement.createSupplier(context, {
        id,
        name: supplier.name,
        externalReferences: [],
      });
      if (!current.link)
        try {
          await application.commitments.linkSupplier(context, id, {
            expectedRevision: current.revision ?? 1,
            link: {
              connectionId: erp.connectionId,
              externalId: erp.supplier(supplier.id),
              scopeKey: '',
            },
            confirmationHours: 4,
          });
        } catch (error) {
          if (conflict(error)) continue;
          throw error;
        }
      done.suppliers.set(supplier.id, id);
    }
  }

  async function rules(context) {
    const detail = await application.replenishment.api.detail(context);
    for (const [index, variant] of plan.variants.entries()) {
      if (done.rules.has(variant.id)) continue;
      const supplierId = done.suppliers.get(variant.supplierId);
      const setup = await application.replenishment.api.setup(context, {
        q: variant.sku,
        connectionId: erp.connectionId,
      });
      const position = setup.positions.find(
        (item) =>
          item.connectionId === erp.connectionId && item.sku === variant.sku,
      );
      if (!supplierId || !position || position.available === null) continue;
      if (setup.rules.some((rule) => rule.positionId === position.positionId)) {
        done.rules.add(variant.id);
        continue;
      }
      const available = Math.max(0, Math.round(position.available));
      try {
        await application.replenishment.api.configure(context, {
          id: stableId(`${runId}:rule:${variant.id}`),
          positionId: position.positionId,
          connectionId: erp.connectionId,
          supplierId,
          minimum:
            index < 2
              ? available + 5
              : Math.max(1, Math.floor(available * 0.85)),
          target: Math.ceil(available * 1.3) + 20,
          approvalQuantity: 150,
          reviewedDigest: detail.versions[0].digest,
        });
      } catch (error) {
        if (conflict(error)) continue;
        throw error;
      }
      done.rules.add(variant.id);
    }
  }

  /**
   * Adds the demo's inbox rules to the mailbox once its suppliers exist. Listing mailboxes
   * creates the mailbox for the new connection; stable rule IDs make repeats no-ops.
   */
  async function inboxRules(context) {
    const mailboxId = manifest.connections?.gmail;
    const messaging = application.messaging?.service;
    if (!mailboxId || !messaging) return;
    const wanted = demoInboxRules(runId, plan.suppliers, (id) =>
      done.suppliers.get(id),
    );
    if (wanted.every((rule) => done.inbox.has(rule.id))) return;
    await messaging.mailboxes(context);
    for (const rule of wanted) {
      if (done.inbox.has(rule.id)) continue;
      try {
        await messaging.addRule(context, mailboxId, rule);
      } catch (error) {
        // An equal rule someone added already covers it; other conflicts retry next pass.
        if (error?.statusCode !== 409) {
          if (conflict(error)) return;
          throw error;
        }
      }
      done.inbox.add(rule.id);
    }
  }

  return {
    async pass() {
      const context = await owner();
      await workflows(context);
      await suppliers(context);
      if (done.suppliers.size) await rules(context);
      if (done.suppliers.size === plan.suppliers.length)
        await inboxRules(context);

      return {
        workflows: done.workflows.size,
        suppliers: done.suppliers.size,
        rules: done.rules.size,
      };
    },
  };
}
