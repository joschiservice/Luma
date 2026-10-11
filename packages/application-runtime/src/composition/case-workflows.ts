import { createHash } from 'node:crypto';

import { createAuditLog } from '@luma/audit/composition';
import type { DetectionService, Incident } from '@luma/exceptions';
import type { IdentityService, TenantContext } from '@luma/identity';
import type { TenantDatabase } from '@luma/platform';
import type { PolicyService } from '@luma/policies';
import {
  createSupplierFollowUp,
  supplierFollowUpSource,
} from '@luma/procurement';
import type { SupplierCommitments } from '@luma/procurement/composition';
import type { OrderWorkspace, ReturnWorkspace } from '@luma/read-models';
import {
  connectionCheckSource,
  createConnectionCheckWorkflow,
  createPaymentFollowUp,
  createRefundFollowUp,
  type PaymentCandidate,
  paymentFollowUpSource,
  type RefundCandidate,
  refundFollowUpSource,
} from '@luma/resolution';
import { createDetectionSources } from '@luma/resolution/composition';
import type {
  CaseReader,
  CaseRunTransport,
  CaseSignal,
  CaseWorkflowAdapter,
  CaseWorkflows,
} from '@luma/workflows';
import {
  compileProcessWorkflow,
  createCaseWorkflowRuntime,
} from '@luma/workflows/composition';

const signal = (incident: Incident): CaseSignal => ({
  id: incident.id,
  issueType: incident.exceptionClass,
  severity: incident.severity,
  subject: {
    kind: incident.subject.subjectKind,
    id: incident.subject.subjectId,
    scope: incident.subject.scope,
  },
  firstDetectedAt: incident.firstDetectedAt,
  lastDetectedAt: incident.lastDetectedAt,
  open: incident.state !== 'resolved',
});

/** Reads cases for workflows through the exceptions owner, in the caller's tenant. */
function caseReader(
  exceptions: Pick<DetectionService, 'list' | 'get' | 'evidence'>,
): CaseReader {
  return {
    open: async (context) =>
      (await exceptions.list(context))
        .filter((incident) => incident.state !== 'resolved')
        .map(signal),
    get: async (context, id) => {
      const incident = await exceptions.get(context, id);

      return incident ? signal(incident) : null;
    },
    evidence: async (context, id) =>
      (await exceptions.evidence(context, id)).map((item) => ({
        key: item.key,
        connectionId: item.connectionId,
        source: item.source,
        observedAt: item.observedAt,
        facts: item.facts,
      })),
  };
}

/**
 * Composes case workflows: Luma's own connection check plus the workflows installed apps
 * contribute. Without a transport, workflows can be reviewed but not turned on.
 */
export function createCaseWorkflowServices(options: {
  database: TenantDatabase;
  identity: Pick<
    IdentityService,
    'refreshContext' | 'resolveWorkflowContext' | 'suspendedMembers'
  >;
  exceptions: Pick<DetectionService, 'list' | 'get' | 'evidence'>;
  policies: Pick<PolicyService, 'approvalRequirement' | 'currentVersion'>;
  sources?: CaseWorkflowAdapter[];
  transport?: CaseRunTransport;
  enabled: boolean;
}): CaseWorkflows {
  return createCaseWorkflowRuntime(options.database, {
    adapters: [
      createConnectionCheckWorkflow({
        version: compileProcessWorkflow(connectionCheckSource),
        sources: createDetectionSources(options.database),
        now: () => new Date(),
      }),
      ...(options.sources ?? []),
    ],
    cases: caseReader(options.exceptions),
    identity: options.identity,
    policies: options.policies,
    audit: createAuditLog(options.database),
    ...(options.transport ? { transport: options.transport } : {}),
    enabled: options.enabled,
  });
}

const stableId = (value: string) => {
  const hex = createHash('sha256').update(value).digest('hex');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

type ReturnListItem = Awaited<
  ReturnType<ReturnWorkspace['list']>
>['items'][number];

type OrderListItem = Awaited<
  ReturnType<OrderWorkspace['list']>
>['items'][number];

const money = (value: { amount: string; currency: string } | null) =>
  value ? `${value.amount} ${value.currency}` : null;

/** How long each follow-up waits. The simulator demo shortens them. */
export interface FollowUpTiming {
  /** Supplier follow-up: how long to wait after noting a follow-up. Defaults to 4 hours. */
  supplierWaitSeconds?: number;
  /** Refund follow-up: how long after items arrive a missing refund counts. Defaults to 48 hours. */
  refundWaitMs?: number;
  /** Payment follow-up: how long after an order is placed a pending payment counts. Defaults to 24 hours. */
  paymentWaitMs?: number;
}

/**
 * Builds the follow-up workflows that start from what owners report: overdue supplier orders,
 * returns waiting for a refund and payments that stay pending. They read through the owners'
 * services and read models, so each reader's access applies.
 */
export function createFollowUpWorkflows(deps: {
  commitments: Pick<SupplierCommitments, 'pending' | 'order' | 'respond'>;
  suppliers(context: TenantContext): Promise<{ link?: unknown }[]>;
  returns: () => Pick<ReturnWorkspace, 'list' | 'get'>;
  orders: () => Pick<OrderWorkspace, 'list' | 'get'>;
  timing?: FollowUpTiming;
}): CaseWorkflowAdapter[] {
  const timing = deps.timing ?? {};
  const refund = (
    item: ReturnListItem,
    receivedAt: string | null,
  ): RefundCandidate => ({
    id: item.id,
    connectionId: item.connectionId,
    name: item.name,
    order: item.order,
    stage: item.stage,
    receivedAt,
    activityAt: item.activityAt,
    value: money(item.value),
  });
  const payment = (item: OrderListItem): PaymentCandidate => ({
    id: item.id,
    connectionId:
      (item.sources.find((s) => s.selected) ?? item.sources[0])?.connectionId ??
      null,
    displayNumber: item.displayNumber,
    status: item.status,
    paymentStatus: item.paymentStatus,
    placedAt: item.placedAt,
    total: money(item.total),
  });
  const paymentWaitMs = timing.paymentWaitMs ?? 24 * 3_600_000;

  return [
    createSupplierFollowUp({
      version: compileProcessWorkflow(
        supplierFollowUpSource(timing.supplierWaitSeconds ?? 4 * 3600),
      ),
      commitments: deps.commitments,
      suppliersLinked: async (context) =>
        (await deps.suppliers(context)).some((supplier) => !!supplier.link),
      id: stableId,
    }),
    createRefundFollowUp({
      version: compileProcessWorkflow(refundFollowUpSource),
      waitMs: timing.refundWaitMs ?? 48 * 3_600_000,
      // The oldest activity is never later than the receipt, so the first page holds the oldest.
      candidates: async (context) =>
        (
          await deps.returns().list(context, {
            q: '',
            view: 'all',
            stage: 'awaiting_refund',
            sort: 'activity',
            direction: 'asc',
            limit: 50,
          })
        ).items.map((item) => refund(item, null)),
      get: async (context, id) => {
        const detail = await deps.returns().get(context, id);

        return detail ? refund(detail.item, detail.timeline.receivedAt) : null;
      },
      returnsShared: async (context) =>
        (
          await deps.returns().list(context, {
            q: '',
            view: 'all',
            sort: 'activity',
            direction: 'desc',
            limit: 1,
          })
        ).sources.some((source) => source.access === 'granted'),
    }),
    createPaymentFollowUp({
      version: compileProcessWorkflow(paymentFollowUpSource),
      waitMs: paymentWaitMs,
      candidates: async (context) =>
        (
          await deps.orders().list(context, {
            q: '',
            view: 'all',
            paymentStatus: 'pending',
            placedBefore: new Date(Date.now() - paymentWaitMs).toISOString(),
            sort: 'placed',
            direction: 'asc',
            limit: 50,
          })
        ).items.map(payment),
      get: async (context, id) => {
        const detail = await deps.orders().get(context, id);

        return detail ? payment(detail.order) : null;
      },
      ordersShared: async (context) =>
        (
          await deps.orders().list(context, {
            q: '',
            view: 'all',
            sort: 'updated',
            direction: 'desc',
            limit: 1,
          })
        ).items.length > 0,
    }),
  ];
}
