import type { TenantContext } from '@luma/identity';
import type {
  CaseWorkflowAdapter,
  ProcessWorkflowVersion,
  TemplateRequirement,
  WorkflowSignal,
} from '@luma/workflows';

/** A return as the refund follow-up sees it, from the returns read model. */
export interface RefundCandidate {
  id: string;
  connectionId: string;
  name: string | null;
  order: { id: string; displayNumber: string | null };
  /** `awaiting_refund` means the items arrived and no refund is recorded. */
  stage: string;
  /** When the items arrived; null when the source doesn't say. */
  receivedAt: string | null;
  /** Latest source event; never earlier than the receipt. */
  activityAt: string;
  value: string | null;
  observedAt: string;
  readable: boolean;
  complete: boolean;
  financialSettled: boolean;
}

/** An order as the payment follow-up sees it, from the orders read model. */
export interface PaymentCandidate {
  id: string;
  connectionId: string | null;
  displayNumber: string | null;
  status: string;
  paymentStatus: string;
  placedAt: string | null;
  total: string | null;
}

const hours = (ms: number) =>
  ms % 3_600_000 === 0
    ? `${ms / 3_600_000} hours`
    : `${Math.round(ms / 60_000)} minutes`;

const day = (time: string | null) => (time ? time.slice(0, 10) : 'unknown');

const noAction = async (): Promise<never> => {
  throw new Error('Follow-ups change nothing in connected systems');
};

/** Shared parts of a follow-up that rereads one record and hands it over while it is open. */
function followUpAdapter<T>(deps: {
  version: ProcessWorkflowVersion;
  template: CaseWorkflowAdapter['template'];
  stepCopy: CaseWorkflowAdapter['stepCopy'];
  requirements(context: TenantContext): Promise<TemplateRequirement[]>;
  prefix: string;
  candidates(context: TenantContext): Promise<T[]>;
  get(context: TenantContext, id: string): Promise<T | null>;
  signal(item: T, now: Date): WorkflowSignal;
  /** The read step's one declared field besides `ready`: whether the follow-up is still open. */
  field: string;
  open(item: T): boolean;
  now(): Date;
  ready?(item: T, now: Date): boolean;
  observedAt?(item: T): string;
}): CaseWorkflowAdapter {
  const recordId = (signalId: string) =>
    signalId.startsWith(deps.prefix) ? signalId.slice(deps.prefix.length) : '';
  const get = async (context: TenantContext, signalId: string) => {
    const id = recordId(signalId);

    return id ? deps.get(context, id) : null;
  };

  return {
    version: deps.version,
    template: deps.template,
    stepCopy: deps.stepCopy,
    handover: 'needs_you',
    requirements: deps.requirements,
    signals: {
      async open(context) {
        const now = deps.now();

        return (await deps.candidates(context))
          .map((item) => deps.signal(item, now))
          .filter((signal) => signal.open);
      },
      async get(context, signalId) {
        const item = await get(context, signalId);

        return item ? deps.signal(item, deps.now()) : null;
      },
    },
    subject: async (_context, signal) => ({
      kind: deps.version.applicability.subjectKind,
      id: recordId(signal.id),
    }),
    async read(context, run) {
      const item = await get(context, run.signal.id);
      const observedAt = deps.now().toISOString();

      return item
        ? {
            values: {
              ready: deps.ready?.(item, deps.now()) ?? true,
              [deps.field]: deps.open(item),
            },
            evidenceRefs: [run.signal.id],
            observedAt: deps.observedAt?.(item) ?? observedAt,
          }
        : {
            values: { ready: false, [deps.field]: false },
            evidenceRefs: [run.signal.id],
            observedAt,
          };
    },
    action: noAction,
    verify: noAction,
  };
}

/**
 * Hands a return to a person once its items arrived and no refund was recorded for `waitMs`.
 * The signal stays open until the return leaves `awaiting_refund`, for example once refunded.
 */
export function createRefundFollowUp(deps: {
  version: ProcessWorkflowVersion;
  /** Returns waiting for a refund, oldest activity first. */
  candidates(context: TenantContext): Promise<RefundCandidate[]>;
  get(
    context: TenantContext,
    returnId: string,
  ): Promise<RefundCandidate | null>;
  /** Whether at least one connection shares returns with Luma. */
  returnsShared(context: TenantContext): Promise<boolean>;
  waitMs: number;
  now?: () => Date;
}): CaseWorkflowAdapter {
  const now = deps.now ?? (() => new Date());
  const fresh = (item: RefundCandidate, at: Date) =>
    item.readable &&
    item.complete &&
    Date.parse(item.observedAt) <= +at &&
    +at - Date.parse(item.observedAt) <= 300_000;
  const settled = (item: RefundCandidate) =>
    fresh(item, now()) && item.financialSettled;

  return followUpAdapter({
    version: deps.version,
    template: {
      trigger: `When returned items arrived and no refund is recorded within ${hours(deps.waitMs)}`,
      steps: [
        'Read the return again',
        'Stop only when fresh complete evidence reports settled money',
        'Hand it to a person in Needs you with the order and refund details',
      ],
      success:
        'A person sees each return still waiting for its refund. Luma never refunds by itself.',
      unit: 'return waiting for a refund',
    },
    stepCopy: {
      return: {
        title: 'Read the return',
        description: 'Reads the return’s current stage and refunds.',
      },
      found: {
        title: 'Find the return',
        description: 'Hands over when the return can no longer be read.',
      },
      settled: {
        title: 'Check for a refund',
        description:
          'Stops only after fresh complete money evidence; otherwise hands the return to a person.',
      },
      done: {
        title: 'Finish',
        description:
          'Records that the refund arrived without anyone stepping in.',
      },
    },
    async requirements(context) {
      const shared = await deps.returnsShared(context);

      return [
        {
          label: 'Returns shared with Luma',
          met: shared,
          detail: shared
            ? 'A connection shares returns and refunds with Luma.'
            : 'Allow a store connection to share returns, so Luma can see when items arrive and refunds are made.',
          fix: shared
            ? null
            : { label: 'Open Connections', destination: 'connections' },
        },
      ];
    },
    prefix: 'return:',
    candidates: deps.candidates,
    get: deps.get,
    signal: (item, at) => {
      const since = item.receivedAt ?? item.activityAt;
      const order = item.order.displayNumber ?? item.order.id;

      return {
        id: `return:${item.id}`,
        issueType: 'refund_overdue',
        severity: 'medium',
        subject: { kind: 'return', id: item.id, scope: [item.connectionId] },
        firstDetectedAt: since,
        lastDetectedAt: at.toISOString(),
        open:
          !!item.receivedAt &&
          !settled(item) &&
          at.getTime() - Date.parse(item.receivedAt) >= deps.waitMs,
        title: `Refund for return ${item.name ?? ''} on order ${order}`.replace(
          '  ',
          ' ',
        ),
        detail: `Items arrived ${day(item.receivedAt)}; no refund is recorded after ${hours(deps.waitMs)}.${item.value ? ` Return value ${item.value}.` : ''}`,
        domain: 'orders',
        record: { kind: 'order', id: item.order.id },
      };
    },
    field: 'waiting',
    open: (item) => !settled(item),
    ready: fresh,
    observedAt: (item) => item.observedAt,
    now,
  });
}

/**
 * Hands an order to a person once its payment stayed pending for `waitMs` after it was placed.
 * The signal stays open until the payment settles or the order is cancelled.
 */
export function createPaymentFollowUp(deps: {
  version: ProcessWorkflowVersion;
  /** Orders whose payment is pending, oldest first. */
  candidates(context: TenantContext): Promise<PaymentCandidate[]>;
  get(
    context: TenantContext,
    orderId: string,
  ): Promise<PaymentCandidate | null>;
  /** Whether at least one active connection shares orders with Luma. */
  ordersShared(context: TenantContext): Promise<boolean>;
  waitMs: number;
  now?: () => Date;
}): CaseWorkflowAdapter {
  const now = deps.now ?? (() => new Date());
  const pending = (item: PaymentCandidate) =>
    item.paymentStatus === 'pending' && item.status !== 'cancelled';

  return followUpAdapter({
    version: deps.version,
    template: {
      trigger: `When an order’s payment is still pending ${hours(deps.waitMs)} after it was placed`,
      steps: [
        'Read the order again',
        'Stop when the payment settled or the order was cancelled',
        'Hand it to a person in Needs you with the order details',
      ],
      success:
        'A person sees each order whose payment stays pending. Luma never holds or cancels it.',
      unit: 'order with a pending payment',
    },
    stepCopy: {
      payment: {
        title: 'Read the order',
        description: 'Reads the order’s current payment status.',
      },
      found: {
        title: 'Find the order',
        description: 'Hands over when the order can no longer be read.',
      },
      settled: {
        title: 'Check the payment',
        description:
          'Stops when the payment settled; otherwise hands the order to a person.',
      },
      done: {
        title: 'Finish',
        description:
          'Records that the payment settled without anyone stepping in.',
      },
    },
    async requirements(context) {
      const shared = await deps.ordersShared(context);

      return [
        {
          label: 'Orders shared with Luma',
          met: shared,
          detail: shared
            ? 'An active connection shares orders and their payment status.'
            : 'Connect a store that shares orders, so Luma can see payment status.',
          fix: shared
            ? null
            : { label: 'Open Connections', destination: 'connections' },
        },
      ];
    },
    prefix: 'order:',
    candidates: deps.candidates,
    get: deps.get,
    signal: (item, at) => {
      const since = item.placedAt ?? at.toISOString();

      return {
        id: `order:${item.id}`,
        issueType: 'payment_pending',
        severity: 'medium',
        subject: {
          kind: 'order',
          id: item.id,
          scope: item.connectionId ? [item.connectionId] : [],
        },
        firstDetectedAt: since,
        lastDetectedAt: at.toISOString(),
        open:
          pending(item) &&
          !!item.placedAt &&
          at.getTime() - Date.parse(item.placedAt) >= deps.waitMs,
        title: `Payment pending for order ${item.displayNumber ?? item.id}`,
        detail: `Placed ${day(item.placedAt)}; the payment is still pending after ${hours(deps.waitMs)}.${item.total ? ` Order total ${item.total}.` : ''}`,
        domain: 'orders',
        record: { kind: 'order', id: item.id },
      };
    },
    field: 'pending',
    open: pending,
    now,
  });
}
