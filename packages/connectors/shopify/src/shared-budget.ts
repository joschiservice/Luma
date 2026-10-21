import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { ConnectorError } from '@luma/connector-core';
import { fail } from '@luma/connector-core/transport';
import { z } from 'zod';

import { maxQueryCost } from './query-cost.js';
import type {
  BudgetFeedback,
  ReadBudget,
  RequestPurpose,
} from './read-budget.js';
import { sharedBudgetScript } from './shared-budget-script.js';

/** An injected region-local atomic store. No credentials or provider payloads are written to it. */
export interface BudgetStore {
  run(
    script: string,
    key: string,
    arguments_: readonly string[],
  ): Promise<unknown>;
}

/** Coordinates one trusted app/shop across processes. Foreground work waits at most two seconds before admission. */
export function createSharedReadBudget(options: {
  store: BudgetStore;
  key: string;
  purpose?: RequestPurpose;
  leaseMs?: number;
  maxWaitMs?: number;
  concurrency?: number;
  /** Bounded waiting for subsequent requests in one compound read, avoiding repeated parent reads. */
  continuationWaitMs?: number;
}): ReadBudget {
  let progressed = false;
  let advisedDelay = 0;
  let unavailableUntil = 0;
  const call = async (args: readonly string[]) => {
    if (performance.now() < unavailableUntil)
      fail('unavailable', 1000, 'ADMISSION_DEFERRED');
    try {
      return z
        .tuple([z.number(), z.number().nonnegative(), z.number().nonnegative()])
        .parse(await options.store.run(sharedBudgetScript, options.key, args));
    } catch {
      unavailableUntil = performance.now() + 1000;
      fail('unavailable', 1000, 'ADMISSION_DEFERRED');
    }
  };
  /**
   * Runs a step that happens before the request leaves. Its failures sent nothing, so they are
   * marked not dispatched with their retry advice kept; execution can then tell a deferred
   * action from one whose outcome is unknown.
   */
  const beforeSending = async <T>(step: () => Promise<T>): Promise<T> => {
    try {
      return await step();
    } catch (error) {
      if (error instanceof ConnectorError && !error.failure.dispatch)
        throw new ConnectorError({
          ...error.failure,
          dispatch: 'not_dispatched',
        });
      throw error;
    }
  };
  const feedback: BudgetFeedback = {
    observe: () => undefined,
    async cooldown(milliseconds) {
      await call(['cooldown', '', '', '', String(milliseconds)]);
    },
  };

  return {
    ...feedback,
    nextDelay: () => advisedDelay,
    async run(shape, send, admission) {
      const id = randomUUID();
      const digest = createHash('sha256').update(shape).digest('hex');
      const purpose = admission?.purpose ?? options.purpose ?? 'foreground';
      const cost = admission?.cost;
      const calculated =
        cost !== undefined && Number.isFinite(cost)
          ? String(Math.min(maxQueryCost, Math.max(1, Math.ceil(cost))))
          : '';
      const deadline =
        performance.now() +
        (progressed
          ? (options.continuationWaitMs ?? options.maxWaitMs ?? 2000)
          : (options.maxWaitMs ?? 2000));
      await beforeSending(async () => {
        for (;;) {
          if (admission?.signal?.aborted) fail('timeout');
          const [admitted, wait] = await call([
            'acquire',
            id,
            digest,
            purpose,
            String(options.leaseMs ?? 125000),
            String(options.concurrency ?? 4),
            admission?.mutation ? '1' : '0',
            calculated,
          ]);
          advisedDelay = admitted ? 0 : wait;
          if (admitted) break;
          if (performance.now() + wait > deadline)
            fail('rate_limited', wait, 'ADMISSION_DEFERRED');
          try {
            await delay(Math.min(wait, 100), undefined, {
              signal: admission?.signal,
            });
          } catch {
            fail('timeout');
          }
        }
        if (admission?.signal?.aborted) {
          await call(['cancel', id, digest, purpose]);
          fail('timeout');
        }
      });
      let dispatched = false;
      let observed: string[] = [];
      let cooldown = 0;
      const requestFeedback: BudgetFeedback = {
        dispatched() {
          dispatched = true;
        },
        beforeSend: () =>
          beforeSending(async () => {
            const [valid] = await call(['check', id, digest, purpose]);
            if (!valid) fail('unavailable', 1000, 'ADMISSION_DEFERRED');
          }),
        observe(_shape, requested, available, rate, actual, capacity) {
          dispatched = true;
          observed = [
            String(requested),
            String(actual ?? requested),
            String(available),
            String(rate),
            String(capacity ?? Math.max(1000, available)),
          ];
        },
        cooldown(milliseconds) {
          cooldown = Math.max(cooldown, milliseconds);
        },
      };
      try {
        const result = await send(requestFeedback);
        progressed = true;

        return result;
      } finally {
        // A provider result remains authoritative if bookkeeping fails. The next request defers.
        await call([
          dispatched ? 'complete' : 'cancel',
          id,
          digest,
          purpose,
          ...Array.from({ length: 5 }, (_, index) => observed[index] ?? ''),
          String(cooldown),
        ]).catch(() => undefined);
      }
    },
  };
}
