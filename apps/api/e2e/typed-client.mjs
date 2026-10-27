// @ts-check
import assert from 'node:assert/strict';

import { createApiClient } from '@luma/api-contract/client';

/** @typedef {import('@luma/api-contract/client').ApiClient} ApiClient */

/**
 * The part of a Fastify app that in-process journeys call: settings and other fixtures expose
 * the runtime app as `f.app`.
 * @typedef {{
 *   inject(options: {
 *     method: string;
 *     url: string;
 *     headers: Record<string, string>;
 *     payload?: Buffer;
 *   }): PromiseLike<{
 *     statusCode: number;
 *     rawPayload: Buffer;
 *     headers: Record<string, string | string[] | number | undefined>;
 *   }>;
 * }} InjectableApp
 */

/** An error status from the API, with the parsed error body when the server sent one. */
class ApiStatusError extends Error {
  /**
   * @param {number} status
   * @param {unknown} body
   */
  constructor(status, body) {
    super(`API responded ${status}: ${JSON.stringify(body)}`);
    this.name = 'ApiStatusError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Creates a typed client for an API process started with `startApi`. Requests carry the
 * browser origin that the API trusts and the person's session cookie, as the web app's do.
 * Responses that do not match the contract reject with a validation error.
 * @param {{ origin: string; browserOrigin?: string; cookie?: string }} options
 * @returns {ApiClient}
 */
export function httpClient({
  origin,
  browserOrigin = 'http://localhost:3000',
  cookie,
}) {
  return createApiClient({
    baseUrl: origin,
    headers: { origin: browserOrigin, ...(cookie ? { cookie } : {}) },
    toError: (status, body) => new ApiStatusError(status, body),
  });
}

/**
 * Creates a typed client that sends requests through `app.inject`, for journeys that build the
 * runtime app in process. `origin` must be one of the app's trusted origins, such as the
 * fixture's `config.baseURL`; `cookie` is a signed-in person's session cookie.
 * @param {InjectableApp} app
 * @param {{ origin: string; cookie?: string }} options
 * @returns {ApiClient}
 */
export function injectClient(app, { origin, cookie }) {
  return createApiClient({
    // inject ignores the host; the path and query select the route.
    baseUrl: 'http://luma.test',
    headers: { origin, ...(cookie ? { cookie } : {}) },
    fetch: (input, init) => injectFetch(app, new Request(input, init)),
    toError: (status, body) => new ApiStatusError(status, body),
  });
}

/**
 * Asserts that a typed client call fails with `status` and returns the error body.
 * @param {Promise<unknown>} call
 * @param {number} status
 * @returns {Promise<unknown>}
 */
export async function expectStatus(call, status) {
  try {
    await call;
  } catch (error) {
    if (!(error instanceof ApiStatusError)) throw error;
    assert.equal(error.status, status, error.message);

    return error.body;
  }
  assert.fail(`Expected the call to fail with ${status}`);
}

/**
 * Answers a fetch request with the app's injected response.
 * @param {InjectableApp} app
 * @param {Request} request
 */
async function injectFetch(app, request) {
  const url = new URL(request.url);
  const body = Buffer.from(await request.arrayBuffer());
  const response = await app.inject({
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(request.headers),
    ...(body.length ? { payload: body } : {}),
  });
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers))
    for (const item of [value].flat())
      if (item !== undefined) headers.append(name, String(item));
  const empty = [204, 205, 304].includes(response.statusCode);

  return new Response(empty ? null : new Uint8Array(response.rawPayload), {
    status: response.statusCode,
    headers,
  });
}
