import { setTimeout as delay } from 'node:timers/promises';

import type { OrderChangePlan, OrderChangePlans } from '@luma/api-contract';
import type { InstalledConnection } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import type {
  CaseRun,
  CaseWorkflowAdapter,
  ProcessStepOutput,
  ProcessWorkflowVersion,
  TemplateRequirement,
} from '@luma/workflows';

import { orderEditCapability } from '../domain/order-edits.js';
import { createGovernedSteps } from './governed-steps.js';
import type { createOrderEdits } from './order-edits.js';

type Edits = Pick<
  ReturnType<typeof createOrderEdits>,
  'status' | 'preview' | 'execute' | 'check'
>;

type PlanStep = OrderChangePlan['steps'][number];

type Reason = OrderChangePlan['safety']['reasons'][number]['code'];

/** Reasons a person settles through the dispatch task: started work and unknown progress. */
const handedToDispatch: Reason[] = ['work_started', 'unknown_progress'];

/** Luma step blocks a dispatch answer can't change. Observe-only is recorded by the edit itself. */
const structural: NonNullable<PlanStep['blockedBy']>[] = [
  'not_granted',
  'unavailable',
  'authority',
  'unmapped',
  'whole_units',
];

const reasonText: Partial<Record<Reason, string>> = {
  shipped:
    'Units of this line have shipped, so the change needs a return or refund first.',
  fulfilled_beyond_target:
    'More units have shipped than the new quantity, so a return or refund comes first.',
  cancelled: 'The order is cancelled.',
  closed: 'The order is completed.',
  stale_evidence:
    'Some systems couldn’t be read again just now, so their quantities may be out of date.',
  incomplete_evidence: 'A system’s latest read failed or was incomplete.',
  ambiguous_line: 'Luma can’t match this line across the systems.',
  unknown_value: 'No system with order-line authority reports this line.',
  authority_unknown: 'No system holds order-line authority.',
  authority_conflict: 'Order-line authority is conflicting.',
  no_fulfilment_source: 'No system reports fulfilment for this order.',
  fulfilment_hidden: 'Luma’s access doesn’t include fulfilment.',
  work_started: 'The warehouse has started work on this line.',
  unknown_progress: 'Luma can’t tell whether the warehouse started this line.',
};

const blockText: Partial<Record<NonNullable<PlanStep['blockedBy']>, string>> = {
  not_granted: 'The Shopify connection doesn’t allow order edits.',
  unavailable: 'The Shopify connection is unavailable.',
  authority:
    'Shopify can only receive the value of the system that holds order-line authority.',
  unmapped: 'Luma can’t match this line to its Shopify line.',
  whole_units: 'Shopify accepts whole quantities only.',
};

/**
 * Builds the workflow that carries an order line's authoritative quantity to dispatch and
 * Shopify. It reads the order's change plan after rereading every source, hands dispatch to the
 * warehouse because Luma can't write dispatch records, proposes the Shopify edit only when a
 * fresh plan shows it safe, and confirms the outcome with fresh reads of every system.
 */
export function createQuantityChangeWorkflow(deps: {
  edits: Edits;
  /** The order's change plans from the host's order read model; absent when it has none. */
  plans?: (
    context: TenantContext,
    orderId: string,
    request: { kind: 'quantity'; lineKey: string; quantity: string } | null,
  ) => Promise<OrderChangePlans | null>;
  /** Rereads the order's sources read more than `maxAgeMs` ago; absent when the host can't. */
  refresh?: (
    context: TenantContext,
    orderId: string,
    maxAgeMs?: number,
  ) => Promise<void>;
  connections(context: TenantContext): Promise<InstalledConnection[]>;
  version: ProcessWorkflowVersion;
  /** Derives a stable UUID from a value. */
  id(value: string): string;
  now(): Date;
}): CaseWorkflowAdapter {
  const { governed, sent } = createGovernedSteps(deps);

  const target = (run: CaseRun) => ({
    orderId: run.run.subject.id,
    lineKey: run.signal.subject.scope[0] ?? '',
  });

  /** The target the run pinned in an earlier read; null before the first read. */
  const pinned = (outputs: ProcessStepOutput[]) => {
    const read = [...outputs]
      .reverse()
      .find(
        (output) =>
          (output.stepId === 'replan' || output.stepId === 'plan') &&
          output.state === 'completed',
      );
    const value = read?.values.targetQuantity;

    return typeof value === 'number' && value >= 0 ? String(value) : null;
  };

  /**
   * Rereads the order's sources and plans the authoritative quantity for the case's line. The
   * first read takes the value the authoritative system reports; later reads keep it, so a
   * second change in the meantime blocks instead of silently changing the target.
   */
  async function plan(
    context: TenantContext,
    run: CaseRun,
    quantity: string | null,
  ): Promise<
    | { plan: OrderChangePlan; asOf: string; quantity: string }
    | { problem: string; differs: boolean; asOf: string }
  > {
    const asOf = deps.now().toISOString();
    if (!deps.plans)
      return {
        problem: 'This Luma server can’t read order plans.',
        differs: true,
        asOf,
      };
    const { orderId, lineKey } = target(run);
    // Every step judges reads taken now: a pick may have changed seconds before an answer.
    await deps.refresh?.(context, orderId, 0);
    if (quantity === null) {
      const detected = await deps.plans(context, orderId, null);
      const found = detected?.plans.find(
        (item) =>
          (item.change.kind === 'quantity' || item.change.kind === 'item') &&
          item.change.lineKey === lineKey,
      );
      if (!found?.change.to)
        return detected?.comparisonState === 'matching'
          ? {
              problem: 'Every system already shows the same quantity.',
              differs: false,
              asOf: detected.asOf,
            }
          : {
              problem:
                detected?.comparisonState === 'inconclusive'
                  ? reasonText.stale_evidence!
                  : reasonText.unknown_value!,
              differs: true,
              asOf: detected?.asOf ?? asOf,
            };
      quantity = found.change.to;
    }
    const plans = await deps.plans(context, orderId, {
      kind: 'quantity',
      lineKey,
      quantity,
    });
    const found = plans?.plans[0];
    if (!plans || !found)
      return {
        problem: 'The order no longer has a current source.',
        differs: true,
        asOf,
      };

    return { plan: found, asOf: plans.asOf, quantity };
  }

  /** The Luma step that edits Shopify, when the plan has one. */
  const shopifyStep = (value: OrderChangePlan) =>
    value.steps.find(
      (item) =>
        item.performer === 'luma' && item.capability === orderEditCapability,
    );

  const evidence = (
    run: CaseRun,
    value: OrderChangePlan | null,
    asOf: string,
  ) => {
    const refs =
      value?.acknowledgements.map(
        (item) =>
          `orders:${target(run).orderId}:${item.connectionId}:${item.readAt}`,
      ) ?? [];

    return {
      evidenceRefs: refs.length ? refs : [run.signal.id],
      observedAt: asOf,
    };
  };

  /** Shopify connections of the workspace, whose acknowledgements say whether Shopify shows it. */
  const shops = async (context: TenantContext) =>
    new Set(
      (await deps.connections(context)).flatMap((item) =>
        item.provider === 'shopify' ? [item.id] : [],
      ),
    );

  /** Describes what the plan says about the change, for reads and their conditions. */
  function assess(value: OrderChangePlan, stores: ReadonlySet<string>) {
    const edit = shopifyStep(value);
    const reasons = value.safety.reasons.map((item) => item.code);
    const blocking = reasons.find((code) => !handedToDispatch.includes(code));
    const shopify = value.acknowledgements.filter((item) =>
      stores.has(item.connectionId),
    );
    const problem = !edit
      ? 'Luma can only carry this change to Shopify, and Shopify already shows it. The other systems need a person.'
      : edit.blockedBy && structural.includes(edit.blockedBy)
        ? (blockText[edit.blockedBy] ?? 'Luma can’t edit this Shopify order.')
        : blocking
          ? (reasonText[blocking] ??
            'Luma can’t establish that the change is safe.')
          : '';

    return {
      ready: problem === '',
      safe:
        value.safety.state === 'safe' &&
        !!edit &&
        (edit.blockedBy === null || edit.blockedBy === 'observe_only'),
      shopifyDiffers:
        !shopify.length || shopify.some((item) => item.state !== 'reflects'),
      targetQuantity: Number(value.change.to),
      workStarted: reasons.includes('work_started'),
      problem:
        problem ||
        (value.safety.state === 'safe'
          ? ''
          : (reasonText[reasons[0]!] ?? 'The change is not safe yet.')),
    };
  }

  return {
    version: deps.version,
    caseOwner: 'principal',
    template: {
      trigger:
        'When detection confirms that an order line shows another quantity in Shopify than in the system that holds order-line authority',
      steps: [
        'Reread every system and read the order’s change plan',
        'Hand the case to a person when the evidence is unusable or the change can’t be made safe',
        'Ask the warehouse to make dispatch carry the new quantity, adjusting a started pick',
        'Reread every system; stop when Shopify already shows the value, and continue only when the change is safe now',
        'Propose the Shopify edit and wait for approval under the workspace rules',
        'Edit Shopify once and confirm it with a fresh Shopify read',
        'Confirm the quantity with fresh reads of every system',
      ],
      success:
        'Every system that reports the line shows the new quantity in fresh reads; systems that don’t report quantities are listed as not reporting. The case closes when detection verifies it independently.',
    },
    stepCopy: {
      plan: {
        title: 'Read the change plan',
        description:
          'Rereads every system of the order and plans the quantity the system with order-line authority reports.',
      },
      'plan-usable': {
        title: 'Check the evidence',
        description:
          'Continues with fresh reads, known authority and a Shopify line Luma can edit. Started work goes to the warehouse next.',
      },
      dispatch: {
        title: 'Ask the warehouse',
        description:
          'A person in the warehouse updates dispatch to the new quantity and adjusts a started pick. Overdue tasks go to admins.',
      },
      'dispatch-adjusted': {
        title: 'Check the answer',
        description:
          'Continues when the warehouse adjusted dispatch; otherwise hands the case to a person.',
      },
      replan: {
        title: 'Read the plan again',
        description:
          'Rereads every system. The answer is not proof: fresh reads must show the change is safe now.',
      },
      'shopify-differs': {
        title: 'Check Shopify',
        description:
          'Stops without a change when Shopify already shows the new quantity.',
      },
      'safe-now': {
        title: 'Check safety',
        description:
          'Continues only when the plan is safe; otherwise hands the case to a person with the reason.',
      },
      'edit-shopify': {
        title: 'Edit the Shopify order',
        description:
          'Proposes the exact quantity. Someone else who can approve changes approves it before Luma commits it once.',
      },
      'check-everywhere': {
        title: 'Confirm every system',
        description:
          'Reads Shopify for the approved quantity and Luma’s edit, then rereads every system: each one that reports the line must show the new quantity.',
      },
      done: {
        title: 'Finish',
        description:
          'Records the confirmed quantity. Detection closes the case.',
      },
    },
    async requirements(context) {
      const connections = await deps.connections(context);
      const has = (provider: string | null, capability: string) =>
        connections.some(
          (item) =>
            (provider === null || item.provider === provider) &&
            item.status === 'active' &&
            item.granted.includes(
              capability as InstalledConnection['granted'][number],
            ),
        );
      const edit = has('shopify', orderEditCapability);
      const fulfilment = has(null, 'fulfillment.read');
      const plans = !!deps.plans && !!deps.refresh;

      return [
        {
          label: 'Shopify with order edit access',
          met: edit,
          detail: edit
            ? 'A Shopify store allows Luma to edit order quantities.'
            : 'Reconnect a Shopify store and allow order edits.',
          fix: edit
            ? null
            : { label: 'Open Connections', destination: 'connections' },
        },
        {
          label: 'Fulfilment progress',
          met: fulfilment,
          detail: fulfilment
            ? 'A connection reports fulfilment, so Luma can tell whether work started.'
            : 'Allow fulfilment reads on the connection that dispatches orders.',
          fix: fulfilment
            ? null
            : { label: 'Open Connections', destination: 'connections' },
        },
        {
          label: 'Order plans',
          met: plans,
          detail: plans
            ? 'Luma can reread an order’s systems and plan the change.'
            : 'This Luma server can’t reread orders or plan changes.',
          fix: null,
        },
      ] satisfies TemplateRequirement[];
    },
    async subject(context, signal) {
      if (
        signal.issueType !== 'order_quantity_mismatch' ||
        signal.subject.kind !== 'order'
      )
        return null;
      const shops = (await deps.connections(context)).some(
        (item) =>
          item.provider === 'shopify' &&
          signal.subject.scope.slice(1).includes(item.id),
      );

      return shops ? { kind: 'order', id: signal.subject.id } : null;
    },
    async read(context, run, readStep, previous = []) {
      const result = await plan(
        context,
        run,
        readStep.id === 'plan' ? null : pinned(previous),
      );
      if ('problem' in result) {
        const values = {
          ready: false,
          targetQuantity: 0,
          workStarted: false,
          problem: result.problem,
        };

        return {
          values:
            readStep.id === 'plan'
              ? values
              : { ...values, safe: false, shopifyDiffers: result.differs },
          ...evidence(run, null, result.asOf),
        };
      }
      const { safe, shopifyDiffers, ...values } = assess(
        result.plan,
        await shops(context),
      );

      return {
        values:
          readStep.id === 'plan' ? values : { ...values, safe, shopifyDiffers },
        ...evidence(run, result.plan, result.asOf),
      };
    },
    async action(context, run, actionStep, previous) {
      return governed(context, run, actionStep.id, deps.edits, async (id) => {
        const quantity = pinned(previous);
        const result = quantity ? await plan(context, run, quantity) : null;
        if (!result || 'problem' in result)
          throw new IdentityError(
            409,
            'CONFLICT',
            result?.problem ?? 'The run has no target quantity.',
          );
        const edit = shopifyStep(result.plan);
        const assessed = assess(result.plan, await shops(context));
        if (!edit?.connectionId || !edit.handoff || !assessed.safe)
          throw new IdentityError(
            409,
            'CONFLICT',
            assessed.problem || 'Luma can’t edit this Shopify order now.',
          );

        return {
          connectionId: edit.connectionId,
          orderId: edit.handoff.orderExternalId,
          requestId: id,
          change: {
            lines: edit.handoff.lines.map((line) => ({
              lineItemId: line.externalId,
              quantity: Number(line.quantity),
            })),
            // Removed units that never left the warehouse return to stock.
            restock: true,
          },
        };
      });
    },
    /**
     * Confirms the edit with a fresh Shopify read, then rereads every system: each one that
     * reports the line must show the target. Systems that don't report it are counted apart.
     */
    async verify(context, run, verification, previous) {
      const status = (id: string) => deps.edits.status(context, id);
      const { id } = await sent(status, run, verification.forStep);
      let edit = await deps.edits.check(context, { id });
      // Shopify can take a moment to reflect an accepted edit in a fresh read.
      for (
        let attempt = 1;
        attempt < 3 && edit.state !== 'verified' && edit.state !== 'denied';
        attempt++
      ) {
        await delay(2000);
        edit = await deps.edits.check(context, { id });
      }
      const quantity = pinned(previous);
      const result =
        quantity && edit.state === 'verified'
          ? await plan(context, run, quantity)
          : null;
      const values = {
        quantity: edit.lines[0]?.quantity ?? 0,
        agreed: false,
        reporting: 0,
        notReporting: 0,
      };
      if (!result || 'problem' in result)
        return {
          state: edit.state === 'denied' ? 'failed' : 'inconclusive',
          values,
          evidenceRefs: [id],
        };
      const reports = result.plan.acknowledgements.filter(
        (item) => item.value !== null,
      );
      const reasons = result.plan.safety.reasons.map((item) => item.code);
      // Systems that don't report the quantity are listed, never counted as agreeing.
      const agreed =
        reports.length > 0 &&
        reports.every((item) => item.state === 'reflects' && item.fresh) &&
        !reasons.some((code) =>
          [
            'stale_evidence',
            'incomplete_evidence',
            'ambiguous_line',
            'unknown_progress',
            'fulfilled_beyond_target',
            'authority_unknown',
            'authority_conflict',
          ].includes(code),
        );
      const differs = reports.some(
        (item) => item.state === 'differs' && item.fresh,
      );

      return {
        state: agreed ? 'verified' : differs ? 'failed' : 'inconclusive',
        values: {
          ...values,
          agreed,
          reporting: reports.length,
          notReporting: result.plan.acknowledgements.length - reports.length,
        },
        evidenceRefs: [
          id,
          ...evidence(run, result.plan, result.asOf).evidenceRefs,
        ],
      };
    },
  };
}
