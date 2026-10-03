import type { RateLimit } from './rate-limit.js';
import type { RecordStore } from './store.js';

export interface ProviderRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  /** Raw bytes to send instead of the JSON body, for malformed responses. */
  bodyText?: string | undefined;
  /** The provider committed the request, but the client never receives the response. */
  lost?: boolean | undefined;
  /** True only when the provider handler committed a mutation. */
  committed?: boolean | undefined;
}

/** Identifies a request for fault targeting, metrics and the journal. */
export interface ProviderTarget {
  /** Luma capability or provider operation name, such as `orders.read`. */
  operation: string;
  /** Provider record the request addresses, when it addresses one. */
  resource?: string | undefined;
  write: boolean;
}

/** A provider change that subscribers, such as Shopify webhooks, may be told about. */
export interface ProviderEvent {
  topic: string;
  /** Provider record the event describes. */
  resource: string;
  /** Webhook payload; subscribers must re-read authoritative state. */
  payload: Record<string, unknown>;
}

/** Execution context for one provider request or merchant command. */
export interface ProviderContext<Config = unknown> {
  store: RecordStore;
  /** Simulation time in epoch milliseconds. */
  now: number;
  /** Real time in epoch milliseconds, for values clients compare with their own clock. */
  wallTime: number;
  instance: string;
  config: Config;
  /**
   * How long changed records stay out of filtered search results. Search-backed list queries
   * exclude records changed within this many simulation milliseconds.
   */
  indexLagMs: number;
  /** Records a change notification; the host delivers it after the transaction commits. */
  notify(event: ProviderEvent): void;
}

/**
 * A simulated provider API. The host owns transport, persistence, failure injection and
 * scheduling; the provider owns its records, protocol and merchant commands.
 */
export interface ProviderSimulator<Config, Command, Result = unknown> {
  kind: string;
  /** PostgreSQL table that holds this provider's records in the host database. */
  table: string;
  identify(request: ProviderRequest): ProviderTarget;
  handle(
    context: ProviderContext<Config>,
    request: ProviderRequest,
  ): Promise<ProviderResponse>;
  /** Applies a merchant, customer or integration action at the context's simulation time. */
  command(context: ProviderContext<Config>, command: Command): Promise<Result>;
  /** The provider's answer to a request with rejected credentials. */
  unauthorized(request: ProviderRequest): ProviderResponse;
  /** Changes a successful response as an incompatible API change would. */
  drift(response: ProviderResponse): ProviderResponse;
  rateLimit?: RateLimit | undefined;
}

/** Constructs a provider JSON response. */
export function json(body: unknown, status = 200): ProviderResponse {
  return { body, status, headers: { 'content-type': 'application/json' } };
}

/** Converts provider handlers to fetch while honoring cancellation before and after dispatch. */
export function createTransport(
  dispatch: (request: ProviderRequest) => Promise<ProviderResponse>,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const body = request.body ? await request.text() : null;
    request.signal.throwIfAborted();
    const responsePromise = dispatch({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body,
    });
    let abort: (() => void) | undefined;
    try {
      const response = await Promise.race([
        responsePromise,
        new Promise<never>((_, reject) => {
          abort = () => reject(request.signal.reason);
          request.signal.addEventListener('abort', abort, { once: true });
          if (request.signal.aborted) abort();
        }),
      ]);
      request.signal.throwIfAborted();
      if (response.lost)
        throw new TypeError('Simulated response lost after commit');

      return new Response(response.bodyText ?? JSON.stringify(response.body), {
        status: response.status,
        headers: response.headers,
      });
    } finally {
      if (abort) request.signal.removeEventListener('abort', abort);
    }
  };
}
