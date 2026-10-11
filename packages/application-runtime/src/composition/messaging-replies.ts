import type { EffectRegistry } from '@luma/connections';
import type { InstalledMessageRuntime } from '@luma/connections/composition';
import type { ExecutionResult } from '@luma/execution';
import { AdmissionRejected } from '@luma/execution';
import { parseAction } from '@luma/execution/composition';
import type { TenantContext } from '@luma/identity';
import { hasPermission } from '@luma/identity';
import type {
  RecordDirectory,
  RecordState,
  RecordStates,
  Replies,
  ReplyAdmission,
  ReplyExecution,
} from '@luma/messaging';
import { canonicalJson } from '@luma/platform';
import type { SupplierCommitments } from '@luma/procurement/composition';

import type { createSafetyServices } from './services.js';

/** The order fields a reply restates, as the order workspace reads them. */
interface OrderReader {
  get(
    context: TenantContext,
    orderId: string,
  ): Promise<{
    order: {
      displayNumber: string | null;
      status: string;
      paymentStatus: string;
      fulfillment: Extract<RecordState, { kind: 'order' }>['fulfillment'];
      dueAt: string | null;
      observedAt: string;
    };
    fulfillments: {
      deleted: boolean;
      tracking: { carrier: string | null; number: string | null }[] | null;
    }[];
  } | null>;
}

/**
 * Reads the current state of linked records for reply drafts with the drafting person's
 * permissions: orders from the order workspace, purchase orders from procurement's supplier
 * lifecycle, and customer and supplier names from the record directory. Unreadable records
 * are left out, so the draft says they cannot be confirmed.
 */
export function createRecordStates(deps: {
  orders: () => OrderReader;
  commitments: () => Pick<SupplierCommitments, 'order'>;
  directory: RecordDirectory;
  now?: () => Date;
}): RecordStates {
  const now = deps.now ?? (() => new Date());

  async function order(context: TenantContext, id: string) {
    const detail = await deps.orders().get(context, id);
    if (!detail) return null;

    return {
      kind: 'order',
      label: detail.order.displayNumber ?? 'order',
      observedAt: detail.order.observedAt,
      status: detail.order.status,
      paymentStatus: detail.order.paymentStatus,
      fulfillment: detail.order.fulfillment,
      dueAt: detail.order.dueAt,
      tracking: detail.fulfillments
        .filter((f) => !f.deleted)
        .flatMap((f) => f.tracking ?? [])
        .flatMap((t) =>
          t.number ? [{ carrier: t.carrier, number: t.number }] : [],
        ),
    } satisfies RecordState;
  }

  async function purchaseOrder(context: TenantContext, id: string) {
    const record = await deps.commitments().order(context, id);
    // Luma's own record is current when read; a placed order is as current as the last read
    // of the purchasing system, which every follow-up read records on the submission.
    const observedAt =
      record.submission?.state === 'submitted'
        ? record.submission.updatedAt
        : now().toISOString();

    return {
      kind: 'purchase_order',
      label: record.order.reference,
      observedAt,
      stage: record.stage,
      expectedDate: record.progress.expectedDate,
      lines: record.progress.lines.map((line) => ({
        description: line.description,
        unit: line.unit,
        confirmed: line.confirmed,
        outstanding: line.outstanding,
        expectedDate: line.expectedDate,
      })),
    } satisfies RecordState;
  }

  return {
    async read(context, records) {
      const states = new Map<string, RecordState>();
      const names = records.filter(
        (r) =>
          (r.kind === 'customer' && hasPermission(context, 'customers.read')) ||
          (r.kind === 'supplier' && hasPermission(context, 'procurement.read')),
      );
      const labels = names.length
        ? await deps.directory.labels(context, names)
        : new Map<string, string>();
      for (const record of records) {
        const key = `${record.kind}:${record.id}`;
        try {
          const state =
            record.kind === 'order'
              ? await order(context, record.id)
              : record.kind === 'purchase_order'
                ? await purchaseOrder(context, record.id)
                : (record.kind === 'customer' || record.kind === 'supplier') &&
                    labels.has(key)
                  ? {
                      kind: record.kind,
                      label: labels.get(key)!,
                      observedAt: now().toISOString(),
                    }
                  : null;
          if (state) states.set(key, state);
        } catch {
          // A record the person cannot read, or that no longer exists, stays unconfirmed.
        }
      }

      return states;
    },
  };
}

/**
 * Resolves `messages.send` intents for replies to the installed mailbox. The stored reply must
 * still match the bound action and content digest; verification is a fresh thread read.
 */
export function createReplyEffects(
  runtime: Pick<InstalledMessageRuntime, 'sendEffects'>,
  replies: () => Replies,
): EffectRegistry {
  return {
    async resolve(context, intent) {
      if (
        intent.capability !== 'messages.send' ||
        intent.target.kind !== 'message_outbound'
      )
        return null;
      const bound = await replies().forAction(context, intent.target.id);
      if (!bound || canonicalJson(bound.action) !== canonicalJson(intent))
        return null;
      const subject = { kind: 'message_outbound', id: intent.target.id };

      return runtime
        .sendEffects({
          map: async () => bound.message,
          checkPreconditions: async (current, action) =>
            canonicalJson(action) === canonicalJson(intent) &&
            replies().eligible(current, { subject, action }),
          verify: async (current) => ({
            ...(await replies().verify(current, intent.target.id)),
            observedAt: new Date().toISOString(),
            evaluatorVersion: 'message-reply/1',
          }),
        })
        .resolve(context, intent);
    },
  };
}

function execution(result: ExecutionResult | null): ReplyExecution {
  if (!result) return { state: 'not_started' };
  if (result.state === 'not_executed') return { state: 'not_executed' };
  if (!('record' in result))
    return {
      state: 'withheld',
      reason:
        result.state === 'denied'
          ? 'Policy or the mailbox no longer allows sending this reply. Nothing was sent.'
          : 'The approval no longer applies. Nothing was sent. Draft the reply again.',
    };
  const { attempt } = result.record;
  if (attempt.dispatch === 'not_dispatched')
    return {
      state: 'withheld',
      reason:
        'The reply, mailbox or approval changed before sending. Nothing was sent.',
    };
  if (attempt.businessOutcome === 'satisfied') return { state: 'verified' };
  if (attempt.businessOutcome === 'violated')
    return {
      state: 'failed',
      reason:
        'The thread holds a different message under this reply’s ID. Check the mailbox before sending anything else.',
    };

  return { state: 'uncertain' };
}

/** Binds replies to the shared Action Admission, policy and execution services. */
export function createReplyAdmission(
  safety: ReturnType<typeof createSafetyServices>,
  effects: EffectRegistry,
): ReplyAdmission {
  const step = 'send';

  return {
    writeMode: (context, connectionId) =>
      safety.execution.writeMode(context, connectionId),
    async prepare(context, outboundId, action) {
      // Risk comes from each reply's action; the artifact allows any risk from low upwards.
      const artifact = await safety.provisioning.activate(context, {
        id: 'messaging-reply',
        version: '1',
        generation: { kind: 'manual', reference: 'messaging-reply/1' },
        steps: {
          [step]: {
            capability: 'messages.send',
            capabilityVersion: '0',
            targetKind: 'message_outbound',
            minimumRisk: 'low',
          },
        },
      });
      await safety.provisioning.bind(context, {
        runId: outboundId,
        stepId: step,
        tenantId: context.tenantId,
        principalId: action.proposedBy.id,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        artifactDigest: artifact.digest,
        subject: { kind: 'message_outbound', id: outboundId },
        eligibilityValidUntil: action.expiresAt,
        action,
      });
      const effect = await effects.resolve(context, action);
      const decision = await safety.policies.evaluate(
        context,
        action,
        parseAction(action).hash,
        {
          available: !!effect && (await effect.checkPreconditions(action)),
          minimumRisk: action.risk,
          // Gmail declares its own send permission; it replaces actions.propose.
          permission: effect?.permission ?? 'actions.propose',
        },
      );

      return {
        id: decision.id,
        outcome: decision.outcome,
        permission: decision.permission,
      };
    },
    async respond(context, decisionId, outcome, expiresAt) {
      await safety.policies.respond(context, decisionId, outcome, expiresAt);
    },
    async execute(context, outboundId) {
      try {
        return execution(
          await safety.execution.execute(context, {
            runId: outboundId,
            stepId: step,
          }),
        );
      } catch (error) {
        if (error instanceof AdmissionRejected)
          return {
            state: 'withheld',
            reason:
              'The reply, thread or approval changed. Nothing was sent. Draft the reply again.',
          };
        throw error;
      }
    },
    async reconcile(context, actionId) {
      const current = await safety.execution.get(context, actionId);
      if (!current) return { state: 'not_started' };
      if (
        current.state === 'succeeded' ||
        current.state === 'failed' ||
        !('record' in current)
      )
        return execution(current);

      return execution(await safety.execution.reconcile(context, actionId));
    },
    async get(context, actionId) {
      return execution(await safety.execution.get(context, actionId));
    },
  };
}
