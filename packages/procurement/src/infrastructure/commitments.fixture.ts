import { createHash, randomUUID } from 'node:crypto';

import type { AuditEntry } from '@luma/audit';
import type { TenantContext } from '@luma/identity';
import { builtInMembership, makeTenantContext } from '@luma/identity';
import type { ModelGateway } from '@luma/platform';

import {
  type CommitmentDependencies,
  type CommitmentTransaction,
  createSupplierCommitments,
} from '../application/commitments.js';
import type {
  PurchasingReadEvidence,
  PurchasingWriteReceipt,
} from '../application/purchasing-reads.js';
import type {
  Commitment,
  Communication,
  Extraction,
  FollowUp,
  Submission,
} from '../domain/commitments.js';
import type { PurchaseOrder, Supplier } from '../domain/procurement.js';
import { extractionOutput } from './extraction-schema.js';
import {
  commitmentInputSchema,
  followUpInputSchema,
  messageInputSchema,
  receiptInputSchema,
  reviewInputSchema,
  submissionDecisionSchema,
  submissionInputSchema,
  supplierLinkInputSchema,
} from './validation.js';

/**
 * An in-memory supplier-commitment service with inspectable records, for owner tests. Pass a
 * model gateway to extract commitments from recorded messages; `overrides` replace
 * dependencies.
 */
export function commitmentFixture(
  gateway: ModelGateway | null = null,
  overrides: Partial<CommitmentDependencies> = {},
) {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const context = (
    tenant = tenantId,
    user = userId,
    role: 'owner' | 'member' = 'owner',
  ): TenantContext =>
    makeTenantContext(
      { userId: user, sessionId: randomUUID() },
      {
        id: tenant,
        name: 'Workspace',
        slug: 'workspace',
        dataRegion: 'AU',
        status: 'active',
      },
      builtInMembership(
        { id: randomUUID(), organizationId: tenant, userId: user },
        role,
      ),
      randomUUID(),
    );
  const supplier: Supplier = {
    id: randomUUID(),
    tenantId,
    name: 'Supplier',
    externalReferences: [],
    createdAt: '2026-10-01T09:00:00.000Z',
  };
  const order: PurchaseOrder = {
    id: randomUUID(),
    tenantId,
    supplierId: supplier.id,
    supplierName: supplier.name,
    reference: 'PO-1',
    authority: 'luma',
    externalReferences: [],
    origin: {},
    lines: [
      {
        id: randomUUID(),
        sku: 'SKU-1',
        description: 'Item',
        quantity: 100,
        unit: 'each',
      },
    ],
    status: 'open',
    revision: 2,
    createdAt: supplier.createdAt,
    updatedAt: supplier.createdAt,
  };
  const commitments: Commitment[] = [];
  const communications = new Map<string, Communication>();
  const extractions: Extraction[] = [];
  const followUps: FollowUp[] = [];
  const submissions: Submission[] = [];
  const audits: AuditEntry[] = [];
  const reads = new Map<string, PurchasingReadEvidence>();
  const receipts = new Map<string, PurchasingWriteReceipt>();
  const commands = new Map<string, { digest: string; result: unknown }>();
  let timeZone = 'UTC';
  const tx: CommitmentTransaction = {
    order: async (id) => (id === order.id ? order : null),
    orders: async () => [order],
    purchaseOrders: async () => [
      { record: order, position: { rank: 0, keys: null, id: order.id } },
    ],
    countPurchaseOrders: async () => 1,
    supplier: async (id) => (id === supplier.id ? supplier : null),
    suppliers: async (ids) => (ids.includes(supplier.id) ? [supplier] : []),
    updateSupplier: async () => {},
    history: async () => [],
    submissions: async () => submissions,
    submission: async (id) => submissions.find((s) => s.id === id) ?? null,
    insertSubmission: async (value) => {
      submissions.unshift(value);
    },
    saveSubmission: async (value, _settled, expected) => {
      const index = submissions.findIndex(
        (s) => s.id === value.id && s.state === expected,
      );
      if (index >= 0) submissions[index] = value;

      return index >= 0;
    },
    liveSubmissions: async () => submissions,
    communications: async () => [...communications.values()],
    communication: async (id) =>
      [...communications.values()].find((c) => c.id === id) ?? null,
    communicationByKey: async (key) => communications.get(key) ?? null,
    insertCommunication: async (value, key) => {
      communications.set(key, value);
    },
    purgeCommunication: async () => {},
    extractions: async (ids) =>
      extractions.filter((e) => ids.includes(e.communicationId)),
    insertExtraction: async (value) => {
      extractions.push(value);
    },
    commitments: async () => commitments,
    commitment: async (id) => commitments.find((c) => c.id === id) ?? null,
    insertCommitment: async (value) => {
      commitments.push(value);

      return value;
    },
    reviewCommitment: async () => {},
    latestObservation: async () => null,
    observations: async () => [],
    insertObservation: async () => {},
    recordRead: async (evidence) => {
      if (!reads.has(evidence.id))
        reads.set(evidence.id, structuredClone(evidence));
    },
    recordWriteReceipt: async (receipt) => {
      if (!receipts.has(receipt.id))
        receipts.set(receipt.id, structuredClone(receipt));
    },
    followUps: async () => followUps,
    insertFollowUp: async (value) => {
      if (followUps.some((f) => f.key === value.key)) return false;
      followUps.push(value);

      return true;
    },
    command: async (id) => commands.get(id) ?? null,
    saveCommand: async (id, digest, result) => {
      commands.set(id, { digest, result });
    },
    audit: async (value) => {
      audits.push(value);
    },
    skuIdentities: async () => new Map(),
    timeZone: async () => timeZone,
  };
  let tail = Promise.resolve();
  let now = new Date('2026-10-02T12:00:00.000Z');
  let enabled = true;
  const deps: CommitmentDependencies = {
    store: {
      transaction: async (tenant, _write, operation) => {
        if (tenant !== tenantId) throw new Error('Tenant has no records');
        const preceding = tail;
        let release = () => {};
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await preceding;
        try {
          return await operation(tx);
        } finally {
          release();
        }
      },
    },
    purchasing: null,
    admission: null,
    refreshContext: async (ctx) => ctx,
    principal: async () => context(),
    openOrder: async () => {},
    verifiedDrafts: async () => new Set(),
    model: {
      gateway,
      available: !!gateway,
      reason: gateway ? '' : 'Not configured',
      output: extractionOutput,
    },
    trace: (ctx) => ({
      tenantId: ctx.tenantId,
      requestId: ctx.requestId,
      traceId: '00000000000000000000000000000001',
      spanId: '0000000000000001',
    }),
    retentionDays: 365,
    reconciliationAvailable: async () => enabled,
    digest: (value) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    id: randomUUID,
    uuid: () => randomUUID(),
    now: () => now,
    parse: {
      link: (input) => supplierLinkInputSchema.parse(input),
      submission: (input) => submissionInputSchema.parse(input),
      decision: (input) => submissionDecisionSchema.parse(input),
      message: (input) => messageInputSchema.parse(input),
      commitment: (input) => commitmentInputSchema.parse(input),
      review: (input) => reviewInputSchema.parse(input),
      followUp: (input) => followUpInputSchema.parse(input),
      receipt: (input) => receiptInputSchema.parse(input),
    },
    ...overrides,
  };
  const request = () => ({
    id: randomUUID(),
    lineId: order.lines[0]!.id,
    kind: 'received' as const,
    quantity: 40,
    damagedQuantity: 2,
    expectedCommitmentId: null,
    expectedDamagedCommitmentId: null,
    receivedAt: '2026-10-02T10:00:00.000Z',
    condition: 'mixed' as const,
    reason: 'Two broken units',
    evidence: ['Delivery note DN-1', 'photo://broken-units'],
  });

  return {
    service: createSupplierCommitments(deps),
    context,
    order,
    supplier,
    commitments,
    followUps,
    submissions,
    audits,
    reads,
    receipts,
    deps,
    request,
    now: (value: string) => {
      now = new Date(value);
    },
    /** Sets the workspace time zone that decides the calendar day for overdue dates. */
    timeZone: (value: string) => {
      timeZone = value;
    },
    enable: (value: boolean) => {
      enabled = value;
    },
  };
}
