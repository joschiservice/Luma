import type { TenantContext } from '@luma/identity';
import type {
  CaseRun,
  CaseWorkflowAdapter,
  ProcessWorkflowVersion,
  WorkflowSignal,
} from '@luma/workflows';

import type { Attention } from '../domain/commitments.js';
import type { SupplierCommitments } from './commitments.js';

type OrderView = Awaited<ReturnType<SupplierCommitments['order']>>;

const overdueKinds: readonly Attention['kind'][] = [
  'confirmation_overdue',
  'delivery_overdue',
];

/**
 * One overdue occurrence: the order, the submission and, for deliveries, the line. Follow-ups
 * move the attention's key, so the ID leaves it out and one run covers the whole occurrence.
 */
const signalId = (
  orderId: string,
  attention: Pick<Attention, 'kind' | 'submissionId' | 'lineId'>,
) =>
  attention.kind === 'confirmation_overdue'
    ? `confirmation:${orderId}:${attention.submissionId ?? ''}`
    : `delivery:${orderId}:${attention.submissionId ?? ''}:${attention.lineId ?? ''}`;

function parse(id: string) {
  const [kind, orderId, submissionId, lineId] = id.split(':');
  if (!orderId || (kind !== 'confirmation' && kind !== 'delivery')) return null;

  return {
    kind: `${kind}_overdue` as Attention['kind'],
    orderId,
    submissionId: submissionId || null,
    lineId: lineId || null,
  };
}

/**
 * Builds the supplier follow-up over the procurement owner's commitments. Its only write is a
 * follow-up on the order through the owner's own response, made as the person who turned the
 * workflow on; the order then leaves Needs you until Luma checks again.
 */
export function createSupplierFollowUp(deps: {
  version: ProcessWorkflowVersion;
  commitments: Pick<SupplierCommitments, 'pending' | 'order' | 'respond'>;
  /** Whether a supplier is linked to a purchasing system that reports confirmations and receipts. */
  suppliersLinked(context: TenantContext): Promise<boolean>;
  /** Derives a stable UUID from a value. */
  id(value: string): string;
  now?: () => Date;
}): CaseWorkflowAdapter {
  const now = deps.now ?? (() => new Date());
  const wait = deps.version.steps.find((step) => step.kind === 'wait');
  const waitMs = (wait?.kind === 'wait' ? wait.seconds : 0) * 1000;
  const followUpId = (run: CaseRun) => deps.id(`${run.run.id}:follow-up`);

  /** Whether the supplier still owes what the occurrence asked for. */
  function waiting(
    view: OrderView,
    target: NonNullable<ReturnType<typeof parse>>,
  ) {
    if (['closed', 'cancelled'].includes(view.order.status)) return false;
    const lines = view.progress.lines;
    if (target.kind === 'confirmation_overdue')
      return lines.every((l) => l.confirmed === null && l.received === 0);
    const line = lines.find((l) => l.lineId === target.lineId);
    const today = now().toISOString().slice(0, 10);

    return (
      !!line &&
      line.outstanding > 0 &&
      (!line.expectedDate || line.expectedDate < today)
    );
  }

  const current = (
    view: OrderView,
    target: NonNullable<ReturnType<typeof parse>>,
  ) =>
    view.progress.attention.find(
      (a) =>
        a.kind === target.kind &&
        (a.submissionId ?? null) === target.submissionId &&
        (a.lineId ?? null) === target.lineId,
    ) ?? null;

  function signal(
    view: OrderView,
    target: NonNullable<ReturnType<typeof parse>>,
    attention: Attention | null,
    open: boolean,
  ): WorkflowSignal {
    const at = now().toISOString();
    const supplier = view.supplier?.name ?? 'The supplier';
    const line = view.progress.lines.find((l) => l.lineId === target.lineId);

    return {
      id: signalId(view.order.id, target),
      issueType: 'supplier_order_overdue',
      severity: 'medium',
      subject: { kind: 'purchase_order', id: view.order.id, scope: [] },
      firstDetectedAt: attention?.dueAt ?? at,
      lastDetectedAt: at,
      open,
      title:
        target.kind === 'confirmation_overdue'
          ? `${supplier} hasn’t confirmed ${view.order.reference}`
          : `${line?.description ?? 'A line'} on ${view.order.reference} is overdue`,
      detail: `${supplier}; ${view.order.reference}${line ? `, ${line.outstanding} ${line.unit} outstanding` : ''}.`,
      domain: 'procurement',
      record: null,
    };
  }

  async function read(context: TenantContext, id: string) {
    const target = parse(id);
    if (!target) return null;
    const view = await deps.commitments
      .order(context, target.orderId)
      .catch(() => null);

    return view ? { target, view } : null;
  }

  async function observe(context: TenantContext, run: CaseRun) {
    const found = await read(context, run.signal.id);
    const observedAt = now().toISOString();
    if (!found)
      return {
        values: { ready: false, waiting: false, key: '' },
        evidenceRefs: [run.signal.id],
        observedAt,
      };

    return {
      values: {
        ready: true,
        waiting: waiting(found.view, found.target),
        key: current(found.view, found.target)?.key ?? '',
      },
      evidenceRefs: [found.view.order.id],
      observedAt,
    };
  }

  return {
    version: deps.version,
    // The order's own Needs you item returns once the follow-up's check date passes.
    handover: 'owner',
    template: {
      trigger:
        'When a supplier hasn’t confirmed a sent order in time, or a delivery is past its expected date',
      steps: [
        'Read the order and stop if the supplier already answered',
        'Note on the order that Luma is following up, so nobody is asked yet',
        `Wait ${Math.round(waitMs / 60_000)} minutes, then check the order again`,
        'Hand it back to a buyer in Needs you if the supplier is still silent',
      ],
      success:
        'Buyers only see orders whose supplier stayed silent after the wait. Nothing is sent to the supplier.',
      unit: 'overdue supplier order',
    },
    stepCopy: {
      order: {
        title: 'Read the order',
        description: 'Reads the supplier’s confirmations and booked receipts.',
      },
      found: {
        title: 'Find the order',
        description: 'Hands over when the order can no longer be read.',
      },
      'still-waiting': {
        title: 'Check the supplier',
        description: 'Stops when the supplier already confirmed or delivered.',
      },
      'record-follow-up': {
        title: 'Note the follow-up',
        description:
          'Records on the order that Luma is following up and when it checks again. It changes nothing at the supplier.',
      },
      'check-follow-up': {
        title: 'Confirm the note',
        description:
          'Reads the order again to confirm the follow-up is recorded.',
      },
      'give-time': {
        title: 'Give the supplier time',
        description: 'Waits before checking the order again.',
      },
      recheck: {
        title: 'Read the order again',
        description: 'Reads confirmations and receipts after the wait.',
      },
      answered: {
        title: 'Check for an answer',
        description:
          'Hands the order back to a buyer when the supplier is still silent.',
      },
      done: {
        title: 'Finish',
        description: 'Records that the supplier answered while Luma waited.',
      },
    },
    approval: {
      mode: 'no_actions',
      summary:
        'This workflow only notes follow-ups on Luma’s own orders. It sends nothing to suppliers or connected systems, so nothing needs approval.',
      details: [
        'The note is recorded as the person who turned the workflow on and appears in the order’s history.',
      ],
    },
    async requirements(context) {
      const linked = await deps.suppliersLinked(context);

      return [
        {
          label: 'A supplier linked to a purchasing system',
          met: linked,
          detail: linked
            ? 'Luma reads confirmations and receipts for linked suppliers.'
            : 'Link a supplier to the purchasing system that receives its orders, so Luma can see confirmations and receipts.',
          fix: linked
            ? null
            : { label: 'Open suppliers', destination: 'procurement' },
        },
      ];
    },
    signals: {
      async open(context) {
        return (await deps.commitments.pending(context))
          .filter((item) => overdueKinds.includes(item.attention.kind))
          .map((item) => {
            const at = now().toISOString();
            const target = { ...item.attention };
            const line = item.order.lines.find(
              (l) => l.id === item.attention.lineId,
            );

            return {
              id: signalId(item.order.id, target),
              issueType: 'supplier_order_overdue',
              severity: 'medium' as const,
              subject: {
                kind: 'purchase_order',
                id: item.order.id,
                scope: [],
              },
              firstDetectedAt: item.attention.dueAt,
              lastDetectedAt: at,
              open: true,
              title: item.attention.summary,
              detail: `${item.supplierName}; ${item.order.reference}${line ? `, ${line.description}` : ''}.`,
              domain: 'procurement' as const,
              record: null,
            };
          });
      },
      async get(context, id) {
        const found = await read(context, id);
        if (!found) return null;

        return signal(
          found.view,
          found.target,
          current(found.view, found.target),
          waiting(found.view, found.target),
        );
      },
    },
    subject: async (_context, item) => ({
      kind: 'purchase_order',
      id: item.subject.id,
    }),
    read: (context, run) => observe(context, run),
    async action(context, run, step, outputs) {
      if (step.id !== 'record-follow-up')
        throw new Error('This workflow has no such action');
      const id = followUpId(run);
      const found = await read(context, run.signal.id);
      if (!found)
        return { state: 'denied', proposalId: id, reason: 'order_not_found' };
      if (found.view.followUps.some((f) => f.id === id))
        return { state: 'accepted', proposalId: id, receiptId: id };
      if (run.stop)
        return { state: 'denied', proposalId: id, reason: run.stop };
      const observed = outputs.find((output) => output.stepId === 'order');
      const key = String(observed?.values.key ?? '');
      if (!key || current(found.view, found.target)?.key !== key)
        return {
          state: 'denied',
          proposalId: id,
          reason: 'The order changed before Luma could note the follow-up',
        };
      const nextCheckAt = new Date(now().getTime() + waitMs).toISOString();
      await deps.commitments.respond(context, found.view.order.id, {
        id,
        key,
        response: 'following_up',
        note: `Luma’s supplier follow-up checks this order again at ${nextCheckAt.slice(11, 16)} UTC.`,
        nextCheckAt,
      });

      return { state: 'accepted', proposalId: id, receiptId: id };
    },
    async verify(context, run) {
      const id = followUpId(run);
      const found = await read(context, run.signal.id);
      const recorded = !!found?.view.followUps.some((f) => f.id === id);

      return {
        state: recorded ? 'verified' : 'failed',
        values: { recorded },
        evidenceRefs: [id],
      };
    },
  };
}
