import { setTimeout as delay } from 'node:timers/promises';

import type { InstalledConnection } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { IdentityError } from '@luma/identity';
import type {
  CaseEvidence,
  CaseRun,
  CaseSignal,
  CaseWorkflowAdapter,
  ProcessWorkflowVersion,
  TemplateRequirement,
} from '@luma/workflows';

import { releasableHoldReasons } from '../domain/case-workflows.js';
import {
  correctionBlocker,
  type CorrectionView,
} from '../domain/inventory-correction.js';
import type { createFulfillmentRecovery } from './fulfillment-recovery.js';
import { createGovernedSteps } from './governed-steps.js';
import type { createInventoryCorrection } from './inventory-correction.js';

type Corrections = Pick<
  ReturnType<typeof createInventoryCorrection>,
  'candidates' | 'inspect' | 'preview' | 'execute' | 'check' | 'status'
>;

type Recovery = Pick<
  ReturnType<typeof createFulfillmentRecovery>,
  'inspect' | 'preview' | 'execute' | 'check' | 'status'
>;

/** Builds the Shopify case workflows over the app's governed correction and recovery services. */
export function createShopifyCaseWorkflows(deps: {
  corrections: Corrections;
  recovery: Recovery;
  /** Finds the stock position for a canonical SKU at a canonical location. */
  position(
    context: TenantContext,
    skuId: string,
    locationId: string,
  ): Promise<string | null>;
  connections(context: TenantContext): Promise<InstalledConnection[]>;
  versions: { stock: ProcessWorkflowVersion; hold: ProcessWorkflowVersion };
  /** Derives a stable UUID from a value. */
  id(value: string): string;
  now(): Date;
}): CaseWorkflowAdapter[] {
  const { conflict, problem, governed, sent } = createGovernedSteps(deps);

  async function connection(
    context: TenantContext,
    provider: string,
    capability: string,
  ) {
    return (await deps.connections(context)).some(
      (item) =>
        item.provider === provider &&
        item.status === 'active' &&
        item.granted.includes(
          capability as InstalledConnection['granted'][number],
        ),
    );
  }

  // Stock correction ------------------------------------------------------------------------

  async function stockSources(
    context: TenantContext,
    run: CaseRun,
  ): Promise<
    | {
        target: {
          positionId: string;
          connectionId: string;
          sourceConnectionId: string;
        };
      }
    | { problem: string }
  > {
    const [, ...connections] = run.signal.subject.scope;
    const candidates = await deps.corrections.candidates(context, {
      positionId: run.run.subject.id,
    });
    const of = (provider: string) =>
      candidates.filter(
        (item) =>
          item.provider === provider && connections.includes(item.connectionId),
      );
    const [erp, shop] = [of('jtl'), of('shopify')];
    if (erp.length !== 1 || shop.length !== 1)
      return {
        problem:
          'This mismatch isn’t between one ERP and one Shopify store, so Luma can’t tell which quantity is right.',
      };

    return {
      target: {
        positionId: run.run.subject.id,
        connectionId: shop[0]!.connectionId,
        sourceConnectionId: erp[0]!.connectionId,
      },
    };
  }

  const stock: CaseWorkflowAdapter = {
    version: deps.versions.stock,
    template: {
      trigger:
        'When detection confirms that Shopify and the ERP disagree on linked stock',
      steps: [
        'Read the ERP quantity and the current Shopify quantity',
        'Hand the case to a person when the sources are ambiguous or stale',
        'Stop when Shopify already matches the ERP',
        'Propose setting Shopify to the ERP quantity',
        'Wait for approval under the workspace rules',
        'Write with compare-and-set and confirm with a fresh Shopify read',
      ],
      success:
        'Shopify shows the ERP quantity in a fresh read. Luma never writes ERP stock. The case closes when detection verifies it independently.',
    },
    stepCopy: {
      stock: {
        title: 'Read both stock sources',
        description:
          'Reads the ERP quantity Luma imported and the live Shopify quantity for this stock position.',
      },
      'usable-evidence': {
        title: 'Check the evidence',
        description:
          'Continues only with one ERP source, one Shopify store, exact mappings and fresh stock.',
      },
      'still-different': {
        title: 'Check the difference',
        description:
          'Stops without a change when Shopify already matches the ERP.',
      },
      'correct-stock': {
        title: 'Correct Shopify stock',
        description:
          'Proposes the exact quantity. Someone else who can approve changes approves it before Luma writes it with compare-and-set.',
      },
      'check-stock': {
        title: 'Confirm the quantity',
        description:
          'Reads Shopify again and requires the approved quantity at the same item and location.',
      },
      done: {
        title: 'Finish',
        description:
          'Records the confirmed quantity. Detection closes the case.',
      },
    },
    async requirements(context) {
      const [shop, erp] = await Promise.all([
        connection(context, 'shopify', 'inventory.available.reconcile'),
        connection(context, 'jtl', 'inventory.read'),
      ]);

      return [
        {
          label: 'Shopify with stock write access',
          met: shop,
          detail: shop
            ? 'A Shopify store allows Luma to correct available stock.'
            : 'Reconnect a Shopify store and allow inventory changes.',
          fix: shop
            ? null
            : { label: 'Open Connections', destination: 'connections' },
        },
        {
          label: 'An ERP stock source',
          met: erp,
          detail: erp
            ? 'An ERP connection reports available stock.'
            : 'Connect JTL so Luma has an authoritative quantity to copy.',
          fix: erp
            ? null
            : { label: 'Open Connections', destination: 'connections' },
        },
      ] satisfies TemplateRequirement[];
    },
    async subject(context, signal) {
      const [locationId, ...connections] = signal.subject.scope;
      if (signal.issueType !== 'inventory_mismatch' || !locationId) return null;
      const shops = (await deps.connections(context)).filter(
        (item) => item.provider === 'shopify' && connections.includes(item.id),
      );
      if (!shops.length) return null;
      const positionId = await deps.position(
        context,
        signal.subject.id,
        locationId,
      );

      return positionId ? { kind: 'inventory_position', id: positionId } : null;
    },
    async read(context, run) {
      const now = deps.now();
      const failed = (problem: string) => ({
        values: {
          ready: false,
          differs: false,
          erpAvailable: 0,
          shopifyAvailable: 0,
          problem,
        },
        evidenceRefs: [run.signal.id],
        observedAt: now.toISOString(),
      });
      const sources = await stockSources(context, run);
      if ('problem' in sources) return failed(sources.problem);
      let inspected;
      try {
        inspected = await deps.corrections.inspect(context, sources.target);
      } catch (error) {
        if (!conflict(error)) throw error;

        return failed(problem(error));
      }
      const { snapshot, granted } = inspected;
      // Judge freshness after the read; a clock taken before it would see the read as future.
      const blocker = correctionBlocker(
        snapshot,
        { capability: 'inventory.available.reconcile' },
        granted,
        deps.now(),
      );
      const differs = snapshot.available !== snapshot.source.available;

      return {
        values: {
          ready: !blocker || !differs,
          differs,
          erpAvailable: snapshot.source.available,
          shopifyAvailable: snapshot.available ?? 0,
          problem: differs ? (blocker ?? '') : '',
        },
        evidenceRefs: [snapshot.id, snapshot.source.observationId],
        observedAt: snapshot.observedAt,
      };
    },
    async action(context, run, step) {
      return governed(
        context,
        run,
        step.id,
        {
          status: deps.corrections.status,
          preview: deps.corrections.preview,
          execute: deps.corrections.execute,
          check: deps.corrections.check,
        },
        async (requestId) => {
          const sources = await stockSources(context, run);
          if ('problem' in sources)
            throw new IdentityError(409, 'CONFLICT', sources.problem);

          return { ...sources.target, requestId };
        },
      );
    },
    async verify(context, run, step) {
      const status = (id: string) => deps.corrections.status(context, id);
      const { id, view } = await sent(status, run, step.forStep);
      let current: CorrectionView = view;
      // Shopify can take a moment to reflect an accepted write in a fresh read.
      for (
        let attempt = 0;
        attempt < 3 && current.state !== 'verified';
        attempt++
      ) {
        if (attempt) await delay(2000);
        current = await deps.corrections.check(context, { id });
      }

      return {
        state: current.state === 'verified' ? 'verified' : 'inconclusive',
        values: { available: current.before.source.available },
        evidenceRefs: [id],
      };
    },
  };

  // Hold release ----------------------------------------------------------------------------

  async function holdTarget(run: {
    signal: CaseSignal;
    evidence(): Promise<CaseEvidence[]>;
  }) {
    const connectionId = run.signal.subject.scope[0];
    const mapping = (await run.evidence()).find(
      (item) =>
        item.facts.fulfillmentId === run.signal.subject.id &&
        typeof item.facts.source === 'object' &&
        typeof item.facts.order === 'object',
    );
    const source = mapping?.facts.source as
      { externalId?: unknown; connectionId?: unknown } | undefined;
    const order = mapping?.facts.order as { externalId?: unknown } | undefined;
    if (
      !connectionId ||
      source?.connectionId !== connectionId ||
      typeof source.externalId !== 'string' ||
      typeof order?.externalId !== 'string' ||
      !source.externalId.startsWith('gid://shopify/FulfillmentOrder/') ||
      !order.externalId.startsWith('gid://shopify/Order/')
    )
      return null;

    return {
      connectionId,
      orderId: order.externalId,
      fulfillmentOrderId: source.externalId,
    };
  }

  const hold: CaseWorkflowAdapter = {
    version: deps.versions.hold,
    template: {
      trigger:
        'When detection confirms a Shopify fulfillment held past the stuck window',
      steps: [
        'Read the fulfillment order and its holds in Shopify',
        'Stop when nothing is held; hand over when several holds or a payment, address or stock hold need their cause fixed',
        'Propose releasing the hold',
        'Wait for approval under the workspace rules',
        'Release it and confirm in Shopify that it is gone',
      ],
      success:
        'Shopify no longer shows the hold. Detection then follows the warehouse progress and closes the case.',
    },
    stepCopy: {
      hold: {
        title: 'Read the holds',
        description: 'Reads the fulfillment order and its holds from Shopify.',
      },
      readable: {
        title: 'Check the evidence',
        description:
          'Continues only with a complete read of a Shopify fulfillment order Luma can change.',
      },
      'is-held': {
        title: 'Check for a hold',
        description:
          'Stops without a change when nothing is held; the case then needs warehouse or carrier follow-up.',
      },
      'one-hold': {
        title: 'Check the hold',
        description:
          'Continues with exactly one fraud-review or manual hold. Other holds need their cause fixed.',
      },
      'release-hold': {
        title: 'Release the hold',
        description:
          'Proposes releasing that exact hold. Someone else who can approve changes approves it before Luma sends it.',
      },
      'check-hold': {
        title: 'Confirm the release',
        description: 'Reads Shopify again and requires the hold to be gone.',
      },
      done: {
        title: 'Finish',
        description:
          'Records the release. Detection closes the case once the order progresses.',
      },
    },
    async requirements(context) {
      const shop = await connection(
        context,
        'shopify',
        'fulfillment.hold.release',
      );

      return [
        {
          label: 'Shopify with fulfillment write access',
          met: shop,
          detail: shop
            ? 'A Shopify store allows Luma to release fulfillment holds.'
            : 'Reconnect a Shopify store and allow fulfillment changes.',
          fix: shop
            ? null
            : { label: 'Open Connections', destination: 'connections' },
        },
      ] satisfies TemplateRequirement[];
    },
    async subject(context, signal, evidence) {
      if (signal.issueType !== 'stuck_fulfillment') return null;
      const target = await holdTarget({
        signal,
        evidence: async () => evidence,
      });
      if (!target) return null;
      const shop = (await deps.connections(context)).some(
        (item) =>
          item.id === target.connectionId && item.provider === 'shopify',
      );

      return shop ? { kind: 'fulfillment', id: signal.subject.id } : null;
    },
    async read(context, run) {
      const now = deps.now().toISOString();
      const failed = (problem: string) => ({
        values: {
          ready: false,
          held: false,
          releasable: false,
          reason: '',
          problem,
        },
        evidenceRefs: [run.signal.id],
        observedAt: now,
      });
      const target = await holdTarget(run);
      if (!target)
        return failed(
          'Luma can’t identify this order’s Shopify fulfillment order.',
        );
      let inspected;
      try {
        inspected = await deps.recovery.inspect(context, target);
      } catch (error) {
        if (!conflict(error)) throw error;

        return failed(problem(error));
      }
      const { snapshot, granted } = inspected;
      if (!snapshot.complete)
        return failed('Shopify returned incomplete fulfillment details.');
      const [first] = snapshot.holds;
      const releasable =
        snapshot.holds.length === 1 &&
        releasableHoldReasons.includes(first!.reason) &&
        snapshot.actions.includes('RELEASE_HOLD') &&
        granted.includes('fulfillment.hold.release');

      return {
        values: {
          ready: true,
          held: snapshot.holds.length > 0,
          releasable,
          reason: first?.reason ?? '',
          problem:
            !snapshot.holds.length || releasable
              ? ''
              : snapshot.holds.length > 1
                ? 'Several holds stop this order. Review them in Shopify.'
                : !releasableHoldReasons.includes(first!.reason)
                  ? `The hold waits for ${first!.reason.toLowerCase().replaceAll('_', ' ')}. Fix that cause first.`
                  : 'Shopify doesn’t allow Luma to release this hold now.',
        },
        evidenceRefs: [snapshot.id],
        observedAt: snapshot.observedAt,
      };
    },
    async action(context, run, step) {
      return governed(
        context,
        run,
        step.id,
        {
          status: deps.recovery.status,
          preview: deps.recovery.preview,
          execute: deps.recovery.execute,
          check: deps.recovery.check,
        },
        async (requestId) => {
          const target = await holdTarget(run);
          if (!target)
            throw new IdentityError(
              409,
              'CONFLICT',
              'Luma can’t identify this order’s Shopify fulfillment order.',
            );
          const { snapshot } = await deps.recovery.inspect(context, target);
          const [only] = snapshot.holds;
          if (
            snapshot.holds.length !== 1 ||
            !releasableHoldReasons.includes(only!.reason)
          )
            throw new IdentityError(
              409,
              'CONFLICT',
              'The order’s holds changed. Review them in Shopify.',
            );

          return {
            ...target,
            requestId,
            choice: {
              capability: 'fulfillment.hold.release',
              holdId: only!.id,
            },
          };
        },
      );
    },
    async verify(context, run, step) {
      const status = (id: string) => deps.recovery.status(context, id);
      const { id, view } = await sent(status, run, step.forStep);
      const holdId =
        view.choice.capability === 'fulfillment.hold.release'
          ? view.choice.holdId
          : null;
      const { snapshot } = await deps.recovery.inspect(context, view.target);
      const held =
        !snapshot.complete || snapshot.holds.some((item) => item.id === holdId);

      return {
        state: snapshot.complete && !held ? 'verified' : 'inconclusive',
        values: { held },
        evidenceRefs: [id, snapshot.id],
      };
    },
  };

  return [stock, hold];
}
