import { randomBytes, randomUUID } from 'node:crypto';

import type { CaseService } from '@luma/exceptions';
import type { TenantContext } from '@luma/identity';
import type { ModelGateway, Observability } from '@luma/platform';
import type {
  FulfillmentWorkspace,
  InventoryWorkspace,
  OrderWorkspace,
  ReturnWorkspace,
} from '@luma/read-models';

import {
  type AssistantAvailability,
  type AssistantLimits,
  createAssistant,
} from './application/assistant.js';
import { createToolRegistry } from './application/tools.js';
import {
  getIssueTool,
  searchIssuesTool,
} from './infrastructure/tools/issues.js';
import {
  searchFulfillmentTool,
  searchReturnsTool,
  searchStockTool,
} from './infrastructure/tools/operations.js';
import {
  getOrderTool,
  searchOrdersTool,
} from './infrastructure/tools/orders.js';

export { assistantModelProfile } from './application/assistant.js';

/**
 * Creates the workspace assistant over the owners' read services. Each tool reads through the
 * same service as the matching page, with the asking member's context.
 */
export function createWorkspaceAssistant(deps: {
  gateway: ModelGateway | null;
  availability: AssistantAvailability;
  reads: {
    orders: Pick<OrderWorkspace, 'list' | 'get'>;
    issues: Pick<CaseService, 'list' | 'get'>;
    inventory: Pick<InventoryWorkspace, 'list'>;
    fulfillment: Pick<FulfillmentWorkspace, 'list'>;
    returns: Pick<ReturnWorkspace, 'list'>;
  };
  refreshContext(context: TenantContext): Promise<TenantContext>;
  observability?: Pick<Observability, 'run'> | undefined;
  limits?: Partial<AssistantLimits>;
}) {
  return createAssistant({
    gateway: deps.gateway,
    availability: deps.availability,
    tools: createToolRegistry([
      searchOrdersTool(deps.reads.orders),
      getOrderTool(deps.reads.orders),
      searchIssuesTool(deps.reads.issues),
      getIssueTool(deps.reads.issues),
      searchStockTool(deps.reads.inventory),
      searchFulfillmentTool(deps.reads.fulfillment),
      searchReturnsTool(deps.reads.returns),
    ]),
    refreshContext: deps.refreshContext,
    observability: deps.observability,
    trace: (context) => ({
      requestId: context.requestId,
      traceId: randomBytes(16).toString('hex'),
      spanId: randomBytes(8).toString('hex'),
    }),
    id: randomUUID,
    now: () => new Date(),
    ...(deps.limits ? { limits: deps.limits } : {}),
  });
}
