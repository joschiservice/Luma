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
