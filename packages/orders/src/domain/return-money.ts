import type { ReturnAction } from './return-actions.js';
import type { ReturnCase } from './return-cases.js';
import type { ExchangeStep } from './return-exchanges.js';
import type { ReturnMoneyEvidence } from './return-waiting.js';

/** The settlement step whose money a deadline check follows: the exchange for exchange proposals, otherwise the refund. */
export function returnMoneyStep(
  value: ReturnCase,
  refund: ReturnAction | null,
  exchange: ExchangeStep | null,
) {
  return value.proposal?.kind === 'exchange' ? exchange : refund;
}

/** Money that was never requested needs no provider read; the case revision is its evidence. */
export function unrequestedReturnMoney(
  value: ReturnCase,
  step: ReturnAction | ExchangeStep | null,
): ReturnMoneyEvidence {
  return {
    state: 'not_requested',
    readable: true,
    complete: true,
    observedAt: value.proposal?.at ?? null,
    evidenceRefs: [`case:${value.id}:${value.revision}`],
    requestedAt: step?.requestedAt ?? null,
  };
}

/**
 * Turns a fresh provider read of a sent step into deadline evidence. It is complete only with a
 * known payment state backed by stored, complete reads; a missing or partial read, or an unknown
 * payment, stays incomplete.
 */
export function observedReturnMoney(
  proof: {
    payment: ReturnMoneyEvidence['state'] | null;
    observedAt: string;
    evidenceRefs: string[];
    complete?: boolean;
  } | null,
  requestedAt: string,
): ReturnMoneyEvidence {
  return {
    state: proof?.payment ?? 'unknown',
    readable: true,
    complete:
      !!proof &&
      proof.complete === true &&
      proof.payment !== null &&
      proof.payment !== 'unknown' &&
      proof.evidenceRefs.length > 0,
    observedAt: proof?.observedAt ?? null,
    evidenceRefs: proof?.evidenceRefs ?? [],
    requestedAt,
  };
}
