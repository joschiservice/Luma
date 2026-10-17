import type { TenantContext } from '@luma/identity';

import type { ReturnActionProof } from '../domain/return-actions.js';
import type { ExchangeProof } from '../domain/return-exchanges.js';
import {
  observedReturnMoney,
  returnMoneyStep,
  unrequestedReturnMoney,
} from '../domain/return-money.js';
import type { ReturnDeadlineSource } from './return-deadlines.js';

/**
 * Reads return money for deadline checks through the settlement owners' fresh provider reads.
 * Steps that were never sent need no read. Without `observe`, reading a sent step throws, and
 * the deadline check records the money as unreadable.
 */
export function createReturnMoneySource(
  observe: {
    refund(
      context: TenantContext,
      caseId: string,
      id: string,
    ): Promise<ReturnActionProof | null>;
    exchange(
      context: TenantContext,
      caseId: string,
      id: string,
    ): Promise<ExchangeProof | null>;
  } | null,
): ReturnDeadlineSource {
  return {
    async money(context, value, refund, exchange) {
      const step = returnMoneyStep(value, refund, exchange);
      if (!step?.sent) return unrequestedReturnMoney(value, step);
      if (!observe) throw new Error('Return financial reads unavailable');
      const proof =
        value.proposal?.kind === 'exchange' && exchange
          ? await observe.exchange(context, value.id, exchange.id)
          : refund
            ? await observe.refund(context, value.id, refund.id)
            : null;

      return observedReturnMoney(proof, step.requestedAt);
    },
  };
}
