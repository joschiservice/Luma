import type { AnyContractRouter, HTTPMethod } from '@orpc/contract';
import { isContractProcedure } from '@orpc/contract';

import type { RouteMeta } from './common.js';

/** One HTTP route declared by a contract, identified by its dotted router key. */
export interface ContractRoute {
  key: string;
  method: HTTPMethod;
  /** OpenAPI path template, such as `/v1/organizations/{organizationId}/orders`. */
  path: `/${string}`;
  meta: RouteMeta;
}

/**
 * Lists every route in a contract router in declaration order. Throws when a procedure has no
 * explicit method and path, because REST routes must not fall back to RPC-style defaults.
 */
export function contractRoutes(
  router: AnyContractRouter,
  prefix: readonly string[] = [],
): ContractRoute[] {
  if (isContractProcedure(router)) {
    const { route, meta } = router['~orpc'];
    const key = prefix.join('.');
    if (!route.method || !route.path)
      throw new Error(`Contract route ${key} needs a method and path`);

    return [
      { key, method: route.method, path: route.path, meta: meta as RouteMeta },
    ];
  }

  return Object.entries(router).flatMap(([name, child]) =>
    contractRoutes(child as AnyContractRouter, [...prefix, name]),
  );
}
