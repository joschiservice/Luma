import type { ProviderRequest, ProviderResponse } from './protocol.js';

/** A provider's request budget, modeled as a leaky bucket that refills continuously. */
export interface RateLimit {
  capacity: number;
  restorePerSecond: number;
  /** Cost of one request; Shopify charges by query cost, REST APIs per request. */
  cost(request: ProviderRequest): number;
  /**
   * Cost the provider actually charges after answering. Shopify admits a query by its
   * requested cost and refunds the difference.
   */
  actualCost?(response: ProviderResponse): number | undefined;
  /** The provider's answer when the budget does not cover the request. */
  reject(cost: number, available: number): ProviderResponse;
  /** Adds budget details to an accepted response, as Shopify does in `extensions.cost`. */
  annotate?(
    response: ProviderResponse,
    cost: number,
    available: number,
  ): ProviderResponse;
}

export interface Bucket {
  available: number;
  /** Real time of the last refill, in epoch milliseconds. */
  at: number;
}

/** Charges a request against a bucket in real time; returns whether it may proceed. */
export function charge(
  limit: RateLimit,
  bucket: Bucket,
  cost: number,
  now: number,
) {
  bucket.available = Math.min(
    limit.capacity,
    bucket.available + ((now - bucket.at) / 1000) * limit.restorePerSecond,
  );
  bucket.at = now;
  if (cost > bucket.available) return false;
  bucket.available -= cost;

  return true;
}
