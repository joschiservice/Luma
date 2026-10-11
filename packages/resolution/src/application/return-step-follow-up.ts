import type { TenantContext } from '@luma/identity';
import type {
  CaseWorkflowAdapter,
  ProcessWorkflowVersion,
  WorkflowSignal,
} from '@luma/workflows';

/** Minimal owner-reported waiting occurrence; source evidence and recorded operator decisions stay separate. */
export interface ReturnStepWait {
  id: string;
  caseId: string;
  orderId: string;
  connectionId: string;
  phase: string;
  reason: string;
  state: string;
  dueAt: string;
  openedAt: string;
  updatedAt: string;
  observedAt: string | null;
  evidenceRefs: string[];
}

/** Runs durable owner handovers for configured return deadlines without any provider write. */
export function createReturnStepFollowUp(deps: {
  version: ProcessWorkflowVersion;
  configured(context: TenantContext): Promise<boolean>;
  tick(context: TenantContext): Promise<void>;
  pending(context: TenantContext): Promise<ReturnStepWait[]>;
  get(context: TenantContext, id: string): Promise<ReturnStepWait | null>;
  now?: () => Date;
}): CaseWorkflowAdapter {
  const now = deps.now ?? (() => new Date());
  const signal = (e: ReturnStepWait): WorkflowSignal => ({
    id: e.id,
    issueType: 'return_step_overdue',
    severity: e.reason === 'failed_money' ? 'high' : 'medium',
    subject: { kind: 'return', id: e.caseId, scope: [e.connectionId] },
    firstDetectedAt: e.dueAt,
    lastDetectedAt: e.updatedAt,
    open: e.state === 'escalated',
    title: `Return ${e.phase} needs its case owner`,
    detail: `${e.reason.replaceAll('_', ' ')}. Deadline ${e.dueAt}. Review the return case and its source evidence.`,
    domain: 'orders',
    record: { kind: 'order', id: e.orderId },
  });
  const noAction = async (): Promise<never> => {
    throw new Error('Return follow-up changes nothing in connected systems');
  };

  return {
    version: deps.version,
    handover: 'owner',
    template: {
      trigger:
        'When a recorded return step passes the merchant’s configured deadline',
      steps: [
        'Read the return case and independent financial evidence',
        'Retain missing, stale, pending and failed evidence separately',
        'Hand overdue work to its current case owner',
      ],
      success:
        'Overdue return steps are owned. Only recorded physical decisions and fresh independent money proof retire their waits.',
      unit: 'overdue return step',
    },
    stepCopy: {
      return: {
        title: 'Read return progress',
        description:
          'Reads the owner’s durable waiting occurrence and its evidence.',
      },
      found: {
        title: 'Check evidence',
        description:
          'Hands over missing evidence without assuming a step happened.',
      },
      settled: {
        title: 'Check progress',
        description: 'Ends only when the owner reports verified progress.',
      },
      done: {
        title: 'Finish',
        description:
          'Retains the independently verified occurrence and earlier escalation.',
      },
    },
    requirements: async (context) => [
      {
        label: 'Merchant return deadlines configured',
        fix: null,
        met: await deps.configured(context),
        detail:
          'Choose receipt, inspection and financial deadlines in Returns before turning this workflow on.',
      },
    ],
    signals: {
      open: async (context) => {
        await deps.tick(context);

        return (await deps.pending(context))
          .filter((e) => e.state === 'escalated')
          .map(signal);
      },
      get: async (context, id) => {
        const e = await deps.get(context, id);

        return e ? signal(e) : null;
      },
    },
    subject: async (_context, s) => ({ kind: 'return', id: s.subject.id }),
    read: async (context, run) => {
      const e = await deps.get(context, run.signal.id);

      return {
        values: { ready: !!e, waiting: e?.state !== 'verified' },
        // This read proves the owner record was read, including absent provider proof.
        evidenceRefs: [
          `return-wait:${run.signal.id}`,
          ...(e?.evidenceRefs ?? []),
        ],
        observedAt: now().toISOString(),
      };
    },
    action: noAction,
    verify: noAction,
  };
}
