import type { Insights } from '@luma/read-models';

/** Navigation lookup requested by the caller; the owner rereads it with current authority. */
export interface AssistantContext {
  record?:
    | {
        kind: 'order' | 'issue' | 'stock_position' | 'fulfillment' | 'customer';
        id: string;
      }
    | undefined;
  collection?:
    | {
        tool:
          | 'search_orders'
          | 'search_issues'
          | 'search_stock'
          | 'search_fulfillment'
          | 'search_returns';
        filters: Record<string, string | number | boolean>;
      }
    | undefined;
  insight?:
    | {
        chart: Parameters<Insights['records']>[1];
        query: Parameters<Insights['records']>[2];
      }
    | undefined;
}

/** Bounded owner review fields supplied to the assistant; eligibility remains owned by the review service. */
export interface AssistantIssueReview {
  permittedDecisions: readonly unknown[];
  refreshable?: boolean | undefined;
  observeOnly?: boolean | undefined;
  policyStale?: boolean | undefined;
  proposal?:
    | {
        id: string;
        capability: string;
        available: boolean;
        expiresAt: string;
        policy: unknown;
        approval: unknown;
      }
    | null
    | undefined;
}
