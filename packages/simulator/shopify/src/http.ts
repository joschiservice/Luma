import type {
  ProviderRequest,
  ProviderResponse,
  RateLimit,
} from '@luma/simulator-core';
import { execute, GraphQLError } from 'graphql';

import { bulkDownload, bulkResolver } from './bulk.js';
import { createLoader, type RequestContext } from './context.js';
import { actualCost, prepare, queryCost, readRequest } from './operation.js';
import type { ShopifyContext } from './records.js';
import { typeResolver } from './resolvers.js';
import { schema } from './schema.js';

export const apiVersion = '2026-07';

const endpoint = `/admin/api/${apiVersion}/graphql.json`;

/** Shopify refuses single queries whose requested cost exceeds this. */
const maxQueryCost = 1000;

/** Shopify Plus leaky bucket. */
const capacity = 2000;

const restoreRate = 100;

/** Shopify's throttle status in `extensions.cost`. */
const throttleStatus = (available: number) => ({
  maximumAvailable: capacity,
  currentlyAvailable: Math.max(0, Math.floor(available)),
  restoreRate,
});

/** Reads the cost extension of a response body. */
function costExtension(response: ProviderResponse) {
  const body = response.body;
  const extensions: unknown =
    typeof body === 'object' && body !== null
      ? Reflect.get(body, 'extensions')
      : undefined;
  const cost: unknown =
    typeof extensions === 'object' && extensions !== null
      ? Reflect.get(extensions, 'cost')
      : undefined;

  return typeof cost === 'object' && cost !== null ? cost : undefined;
}

/** A Shopify Admin API response with its API version header. */
const respond = (body: unknown, status = 200): ProviderResponse => ({
  status,
  headers: {
    'content-type': 'application/json',
    'x-shopify-api-version': apiVersion,
  },
  body,
});

/**
 * Formats a GraphQL error as Shopify does. Failures inside resolvers that are not GraphQL
 * errors are reported as `INTERNAL_SERVER_ERROR`.
 */
function format(error: GraphQLError, fallback?: string) {
  const internal =
    error.originalError !== undefined &&
    !(error.originalError instanceof GraphQLError);
  const code =
    error.extensions.code ?? (internal ? 'INTERNAL_SERVER_ERROR' : fallback);

  return {
    message: error.message,
    ...(error.locations ? { locations: error.locations } : {}),
    ...(error.path ? { path: error.path } : {}),
    ...(code ? { extensions: { ...error.extensions, code } } : {}),
  };
}

/** Shopify's answer to a missing or rejected access token. */
export function unauthorized(): ProviderResponse {
  return respond(
    {
      errors:
        '[API] Invalid API key or access token (unrecognized login or wrong password)',
    },
    401,
  );
}

/**
 * Answers an Admin API GraphQL request from the shop's records. Only POST requests to the
 * 2026-07 endpoint with an access token are served. Query and validation errors return HTTP
 * 200 with `errors`, as Shopify does; mutations that changed records set `committed`.
 */
export async function handle(
  context: ShopifyContext,
  request: ProviderRequest,
): Promise<ProviderResponse> {
  const download = await bulkDownload(context, request);
  if (download) return download;
  if (request.method !== 'POST' || new URL(request.url).pathname !== endpoint)
    return respond({ errors: 'Not Found' }, 404);
  if (!request.headers['x-shopify-access-token']) return unauthorized();
  const body = readRequest(request);
  if (!body)
    return respond(
      { errors: { query: 'Required parameter missing or invalid' } },
      400,
    );
  const { document, errors } = prepare(body.query);
  if (!document || errors.length)
    return respond({
      errors: errors.map((error) => format(error, 'GRAPHQL_VALIDATION_FAILED')),
    });
  const cost = queryCost(document, body.operationName, body.variables);
  if (cost > maxQueryCost)
    return respond({
      errors: [
        {
          message: `Query cost is ${cost}, which exceeds the single query max cost limit (${maxQueryCost}).`,
          extensions: {
            code: 'MAX_COST_EXCEEDED',
            cost,
            maxCost: maxQueryCost,
          },
        },
      ],
    });
  const requestContext: RequestContext = {
    shop: context,
    loader: createLoader(context.store),
    committed: false,
  };
  const result = await execute({
    schema,
    document,
    variableValues: body.variables,
    operationName: body.operationName,
    contextValue: requestContext,
    fieldResolver: bulkResolver,
    typeResolver,
  });
  const actual = actualCost(
    document,
    body.operationName,
    body.variables,
    result.data,
  );

  return {
    ...respond({
      ...(result.data === undefined ? {} : { data: result.data }),
      ...(result.errors
        ? { errors: result.errors.map((error) => format(error)) }
        : {}),
      // Without the host's bucket, report a full one; `rateLimit.annotate` sets the live state.
      extensions: {
        cost: {
          requestedQueryCost: cost,
          actualQueryCost: actual,
          throttleStatus: throttleStatus(capacity - actual),
        },
      },
    }),
    ...(requestContext.committed ? { committed: true } : {}),
  };
}

/** Replaces the first ID, or else the first value, in an object graph with null. */
function nullify(value: unknown, key?: string): boolean {
  if (Array.isArray(value)) return value.some((item) => nullify(item, key));
  if (typeof value !== 'object' || value === null) return false;
  for (const [name, item] of Object.entries(value))
    if (
      key === undefined
        ? item !== null && typeof item !== 'object'
        : name === key && typeof item === 'string'
    ) {
      Reflect.set(value, name, null);

      return true;
    }

  return Object.values(value).some((item) => nullify(item, key));
}

/**
 * Returns a successful response as an incompatible API change would: the first record ID, or
 * the first value when there is none, becomes null although the schema declares it non-null.
 */
export function drift(response: ProviderResponse): ProviderResponse {
  const body = response.body;
  if (response.status !== 200 || typeof body !== 'object' || body === null)
    return response;
  const data: unknown = structuredClone(Reflect.get(body, 'data'));
  if (!nullify(data, 'id') && !nullify(data)) return response;

  return { ...response, body: { ...body, data } };
}

/**
 * Shopify's calculated query cost limit: a 2,000 point bucket restored at 100 points per
 * second. A request needs its requested cost available; Shopify then deducts only the actual
 * cost, which `actualCost` reads so the host can refund the difference. Throttled requests
 * return HTTP 200 with a `THROTTLED` error and the throttle status the client uses to wait.
 */
export const rateLimit: RateLimit & {
  /** Actual cost of an answered request, or undefined when it was not executed. */
  actualCost(response: ProviderResponse): number | undefined;
} = {
  capacity,
  restorePerSecond: restoreRate,
  cost(request) {
    const body = readRequest(request);
    const document = body && prepare(body.query).document;

    return body && document
      ? Math.max(1, queryCost(document, body.operationName, body.variables))
      : 0;
  },
  actualCost(response) {
    const cost = costExtension(response);
    const actual: unknown = cost && Reflect.get(cost, 'actualQueryCost');

    return typeof actual === 'number' ? actual : undefined;
  },
  reject(cost, available) {
    return respond({
      errors: [
        {
          message: 'Throttled',
          extensions: {
            code: 'THROTTLED',
            documentation: 'https://shopify.dev/api/usage/rate-limits',
          },
        },
      ],
      extensions: {
        cost: {
          requestedQueryCost: cost,
          actualQueryCost: null,
          throttleStatus: throttleStatus(available),
        },
      },
    });
  },
  annotate(response, cost, available) {
    const body = response.body;
    if (response.status !== 200 || typeof body !== 'object' || body === null)
      return response;
    const extensions: unknown = Reflect.get(body, 'extensions');

    return {
      ...response,
      body: {
        ...body,
        extensions: {
          ...(typeof extensions === 'object' ? extensions : {}),
          cost: {
            requestedQueryCost: cost,
            actualQueryCost: rateLimit.actualCost(response) ?? cost,
            throttleStatus: throttleStatus(available),
          },
        },
      },
    };
  },
};
