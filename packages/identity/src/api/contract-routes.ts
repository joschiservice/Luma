import { contractRoutes } from '@luma/api-contract';
import type { AnyContractRouter } from '@orpc/contract';
import { StandardOpenAPIHandler } from '@orpc/openapi/standard';
import type { Router } from '@orpc/server';
import { ORPCError } from '@orpc/server';
import {
  sendStandardResponse,
  toStandardLazyRequest,
} from '@orpc/standard-server-fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { TenantContext } from '../domain/context.js';

/**
 * Context every contract handler receives: the Fastify request after the identity guard ran,
 * and its reply for response headers such as cookies.
 */
export interface HttpContext {
  request: FastifyRequest;
  reply: FastifyReply;
}

export interface ContractRouteOptions {
  /**
   * Runs after an API app read a route marked `personalData` successfully, before the response
   * is sent, with the response body. A failure fails the request, so no unrecorded read leaves.
   */
  recordPersonalRead?(
    context: TenantContext,
    route: string,
    body: unknown,
  ): Promise<void>;
}

/**
 * Registers one Fastify route per contract route, so hooks see the matched URL pattern and the
 * guard reads the access the contract declares. Requests failing input validation reject with
 * a 400 error; every other failure, including invalid handler output, reaches the Fastify error
 * handler unchanged.
 */
export function registerContractRoutes<T extends AnyContractRouter>(
  app: FastifyInstance,
  contract: T,
  router: Router<T, HttpContext>,
  options: ContractRouteOptions = {},
) {
  const failures = new WeakMap<FastifyRequest, unknown>();
  const handler = new StandardOpenAPIHandler<HttpContext>(router, {
    interceptors: [
      async ({ next, context }) => {
        try {
          return await next();
        } catch (error) {
          failures.set(context.request, error);
          throw error;
        }
      },
    ],
  });
  for (const route of contractRoutes(contract))
    app.route({
      method: route.method,
      url: route.path.replace(/\{(\w+)\}/g, ':$1'),
      config: {
        ...(route.meta.access ? { access: route.meta.access } : {}),
        ...(route.meta.readOnly ? { readOnly: true as const } : {}),
        ...(route.meta.publicApi ? { publicApi: true as const } : {}),
      },
      handler: async (request, reply) => {
        const standardRequest = toStandardLazyRequest(request, reply);
        // Fastify answers HEAD with the GET route and omits the body; oRPC only matches GET.
        if (standardRequest.method === 'HEAD') standardRequest.method = 'GET';
        const result = await handler.handle(standardRequest, {
          context: { request, reply },
        });
        if (failures.has(request)) throw requestError(failures.get(request));
        if (!result.matched)
          throw new Error(`Contract route ${route.key} did not match`);
        if (
          route.meta.personalData &&
          request.tenantContext?.apiApp &&
          result.response.status < 300
        )
          await options.recordPersonalRead?.(
            request.tenantContext,
            route.path,
            result.response.body,
          );
        await sendStandardResponse(reply, result.response);
      },
    });
}

function requestError(error: unknown) {
  if (error instanceof ORPCError && error.code === 'BAD_REQUEST')
    return Object.assign(new Error('Invalid request', { cause: error }), {
      statusCode: 400,
    });

  return error;
}
