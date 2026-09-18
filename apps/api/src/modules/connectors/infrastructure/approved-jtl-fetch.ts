import { request } from 'node:https';
import { isIP } from 'node:net';

export interface ApprovedJtlEndpoint {
  tenantId: string;
  baseUrl: string;
  addresses: readonly string[];
}

/** Pin the socket address while retaining TLS hostname verification for the approved API root. */
export function approvedJtlFetch(
  endpoint: ApprovedJtlEndpoint,
): typeof globalThis.fetch {
  const base = new URL(endpoint.baseUrl);
  return async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(base.pathname) ||
      url.username ||
      url.password ||
      (init?.method ?? 'GET') !== 'GET'
    )
      throw new Error('JTL destination is not approved');
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'GET',
          headers: Object.fromEntries(new Headers(init?.headers)),
          signal: init?.signal ?? AbortSignal.timeout(15000),
          agent: false,
          lookup: (_hostname, options, callback) => {
            const addresses = endpoint.addresses.map((address) => ({
              address,
              family: isIP(address),
            }));
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, addresses[0]!.family);
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1024 * 1024)
              response.destroy(
                new Error('JTL response exceeds the verification limit'),
              );
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            const headers = new Headers();
            for (const [key, value] of Object.entries(response.headers)) {
              if (value !== undefined)
                headers.set(
                  key,
                  Array.isArray(value) ? value.join(', ') : value,
                );
            }
            const status = response.statusCode ?? 502;
            resolve(
              new Response(
                [204, 205, 304].includes(status) ? null : Buffer.concat(chunks),
                { status, headers },
              ),
            );
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  };
}
