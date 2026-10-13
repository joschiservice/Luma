import type { ProviderRuntimeOptions } from '../application/provider.js';
import { ConnectorError } from '../domain/capabilities.js';

/** Bounds an already selected, authorized read transport; never replaces endpoint approval or write controls. */
export function boundedReadTransport(
  transport: typeof globalThis.fetch,
  bounds: ProviderRuntimeOptions['readBounds'],
): typeof globalThis.fetch {
  if (!bounds) return transport;
  let requests = 0,
    totalBytes = 0;
  const reject = (code: 'timeout' | 'invalid_response'): never => {
    throw new ConnectorError({ code, effect: 'none', retry: 'never' });
  };

  return async (input, init) => {
    if (bounds.signal.aborted) reject('timeout');
    if (++requests > bounds.maxRequests) reject('invalid_response');
    const signal = AbortSignal.any([
      bounds.signal,
      ...(init?.signal ? [init.signal] : []),
      ...(input instanceof Request ? [input.signal] : []),
    ]);
    const response = await transport(input, { ...init, signal });
    const reader = response.body?.getReader();
    if (!reader) return response;
    const abort = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', abort, { once: true });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        if (signal.aborted) reject('timeout');
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        totalBytes += chunk.value.byteLength;
        if (
          bytes > bounds.maxResponseBytes ||
          totalBytes > bounds.maxTotalBytes
        )
          reject('invalid_response');
        chunks.push(chunk.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
    if (signal.aborted) reject('timeout');
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
