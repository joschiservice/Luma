import { ConnectorError } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { ServiceError } from '@luma/platform';
import type { CaseRun, ProcessActionResult } from '@luma/workflows';

/** What a case workflow needs to know about one of the app's governed changes. */
export interface GovernedView {
  observeOnly?: boolean | undefined;
  decisionId: string | null;
  state:
    | 'preview'
    | 'approval_required'
    | 'denied'
    | 'accepted'
    | 'uncertain'
    | 'verified'
    | 'recovery_required';
  denial: string | null;
  acceptance: 'not_sent' | 'accepted' | 'unknown';
  canExecute: boolean;
}

/** One governed change service: persisted preview, approval, execution and independent check. */
export interface GovernedService<T extends GovernedView> {
  status(context: TenantContext, id: string): Promise<T | null>;
  preview(context: TenantContext, input: unknown): Promise<T>;
  execute(context: TenantContext, input: unknown): Promise<T>;
  check(context: TenantContext, input: unknown): Promise<T>;
}

/** Proposals one run may prepare after earlier ones expired before anyone decided. */
const maxAttempts = 12;

/**
 * Drives the app's governed changes from case workflow steps. Settled refusals hand the case to a
 * person; transient failures throw so the activity retries.
 */
export function createGovernedSteps(deps: {
  /** Derives a stable UUID from a value. */
  id(value: string): string;
}) {
  // Settled failures hand the case to a person; transient ones let the activity retry.
  const conflict = (error: unknown) =>
    (error instanceof ServiceError && [404, 409].includes(error.statusCode)) ||
    (error instanceof ConnectorError && error.failure.retry === 'never');
  const problem = (error: unknown) =>
    error instanceof ServiceError
      ? error.message
      : error instanceof ConnectorError && error.failure.code === 'not_found'
        ? 'Shopify no longer has this record.'
        : error instanceof ConnectorError &&
            ['authentication', 'permission_denied'].includes(error.failure.code)
          ? 'Shopify rejected Luma’s access. Reconnect the store.'
          : 'Shopify refused this read.';

  /** Lists this step's previews in order; the next ID is null once the run used all attempts. */
  async function attempts<T extends GovernedView>(
    status: (id: string) => Promise<T | null>,
    run: CaseRun,
    stepId: string,
  ) {
    let latest: { id: string; view: T } | null = null;
    for (let n = 0; n < maxAttempts; n++) {
      const id = deps.id(`${run.run.id}:${stepId}:${n}`);
      const view = await status(id);
      if (!view) return { latest, next: id };
      latest = { id, view };
    }

    return { latest, next: null };
  }

  /**
   * Moves one governed change forward: prepares a preview, waits for its approval, runs it as
   * the requester, and reconciles uncertain writes. A preview that expired or went stale before
   * anyone decided is replaced with a fresh one; a rejection or policy denial ends the attempt.
   */
  async function governed<T extends GovernedView>(
    context: TenantContext,
    run: CaseRun,
    stepId: string,
    service: GovernedService<T>,
    previewInput: (requestId: string) => Promise<unknown>,
  ): Promise<ProcessActionResult> {
    const found = await attempts(
      (id) => service.status(context, id),
      run,
      stepId,
    );
    let current = found.latest;
    const replace =
      !current ||
      (current.view.state === 'denied' &&
        (current.view.denial === 'expired' ||
          current.view.denial === 'changed'));
    if (replace) {
      const proposalId = current?.id ?? run.run.id;
      if (run.stop) return { state: 'denied', proposalId, reason: run.stop };
      if (!found.next)
        return { state: 'denied', proposalId, reason: 'approval_not_given' };
      try {
        current = {
          id: found.next,
          view: await service.preview(context, await previewInput(found.next)),
        };
      } catch (error) {
        if (!conflict(error)) throw error;

        return {
          state: 'denied',
          proposalId,
          reason: problem(error),
        };
      }
    }
    const { id } = current!;
    let { view } = current!;
    // Turning the workflow off or closing the case stops a change that hasn't been sent.
    if (run.stop && view.acceptance === 'not_sent')
      return { state: 'denied', proposalId: id, reason: run.stop };
    if (view.state === 'preview') view = await service.check(context, { id });
    if (view.canExecute || view.observeOnly) {
      try {
        view = await service.execute(context, { id });
      } catch (error) {
        if (!conflict(error) || !view.decisionId) throw error;

        return {
          state: 'awaiting_approval',
          proposalId: id,
          decisionId: view.decisionId,
        };
      }
    }
    if (view.observeOnly)
      return { state: 'not_executed', proposalId: id, reason: 'observe_only' };
    if (view.state === 'uncertain') view = await service.check(context, { id });
    switch (view.state) {
      case 'verified':
      case 'recovery_required':
      case 'accepted':
        return { state: 'accepted', proposalId: id, receiptId: id };
      case 'uncertain':
        return {
          state: 'reconciliation_required',
          proposalId: id,
          reason: 'reconciliation_required',
        };
      case 'denied':
        return {
          state: 'denied',
          proposalId: id,
          reason:
            view.denial === 'rejected'
              ? 'approval_rejected'
              : view.denial === 'withheld' || view.denial === 'not_applied'
                ? 'not_accepted'
                : view.denial === 'policy'
                  ? 'policy_denied'
                  : 'evidence_changed',
        };
      default:
        if (!view.decisionId)
          throw new Error('The change has no approval decision');

        return {
          state: 'awaiting_approval',
          proposalId: id,
          decisionId: view.decisionId,
        };
    }
  }

  /** The latest preview this run sent, if any. */
  async function sent<T extends GovernedView>(
    status: (id: string) => Promise<T | null>,
    run: CaseRun,
    stepId: string,
  ) {
    const { latest } = await attempts(status, run, stepId);
    if (!latest || latest.view.acceptance === 'not_sent')
      throw new Error('No accepted change to check');

    return latest;
  }

  return { conflict, problem, governed, sent };
}
