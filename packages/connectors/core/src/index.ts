export type ConnectorErrorCode =
  | 'unavailable'
  | 'unsupported_capability'
  | 'unsupported_version'
  | 'invalid_input'
  | 'invalid_response'
  | 'export_unavailable'
  | 'authentication'
  | 'permission_denied'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'timeout'
  | 'transient'
  | 'internal';

export interface ConnectorFailure {
  dispatch?: 'not_dispatched' | 'dispatched' | 'uncertain';
  providerRequestId?: string;
  code: ConnectorErrorCode;
  /**
   * The provider's own error code, such as Shopify's `MAX_COST_EXCEEDED`, kept for diagnosis.
   * It distinguishes causes that share a normalized `code`, such as provider drift and a query
   * the adapter built wrongly.
   */
  providerCode?: string;
  effect: 'none' | 'unknown';
  retry: 'never' | 'after_delay' | 'reconcile';
  retryAfterMs?: number;
}

/** Carries normalized, non-sensitive failure metadata across adapter boundaries. */
export class ConnectorError extends Error {
  constructor(readonly failure: ConnectorFailure) {
    super(failure.code);
  }
}
