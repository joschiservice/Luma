import { randomBytes, randomUUID } from 'node:crypto';

import type { CaseService } from '@luma/exceptions';
import type { TenantContext } from '@luma/identity';
import type {
  ModelGateway,
  ModelRequestLimit,
  Observability,
} from '@luma/platform';
import type {
  CustomerWorkspace,
  FulfillmentWorkspace,
  Insights,
  InventoryWorkspace,
  OrderWorkspace,
  ReturnWorkspace,
} from '@luma/read-models';

import {
  type AssistantAvailability,
  type AssistantLimits,
  createAssistant,
} from './application/assistant.js';
import type { AssistantIssueReview } from './application/context.js';
import { createToolRegistry } from './application/tools.js';
import { insightTools } from './infrastructure/tools/insights.js';
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
import {
  getCustomerTool,
  getFulfillmentTool,
  getStockTool,
} from './infrastructure/tools/records.js';

export { assistantModelProfile } from './application/assistant.js';

/**
 * Creates the workspace assistant over the owners' read services. Each tool reads through the
 * same service as the matching page, with the asking member's context.
 */
export function createWorkspaceAssistant(deps: {
  gateway: ModelGateway | null;
  /** Limits how often one person may ask; without it only the gateway's budgets apply. */
  requestLimit?: ModelRequestLimit | undefined;
  availability: AssistantAvailability;
  reads: {
    orders: Pick<OrderWorkspace, 'list' | 'get'>;
    issues: Pick<CaseService, 'list' | 'get'>;
    reviewIssue?: (
      context: TenantContext,
      id: string,
    ) => Promise<AssistantIssueReview>;
    insights?: Insights;
    inventory: Pick<InventoryWorkspace, 'list'> &
      Partial<Pick<InventoryWorkspace, 'get'>>;
    fulfillment: Pick<FulfillmentWorkspace, 'list'> &
      Partial<Pick<FulfillmentWorkspace, 'get'>>;
    customers?: Pick<CustomerWorkspace, 'get'>;
    returns: Pick<ReturnWorkspace, 'list'>;
  };
  contextualEnabled?(context: TenantContext): Promise<boolean>;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  observability?: Pick<Observability, 'run'> | undefined;
  limits?: Partial<AssistantLimits>;
}) {
  return createAssistant({
    gateway: deps.gateway,
    requestLimit: deps.requestLimit,
    availability: deps.availability,
    contextualEnabled: deps.contextualEnabled,
    tools: createToolRegistry([
      searchOrdersTool(deps.reads.orders),
      getOrderTool(deps.reads.orders),
      searchIssuesTool(deps.reads.issues),
      getIssueTool(deps.reads.issues, deps.reads.reviewIssue),
      searchStockTool(deps.reads.inventory),
      searchFulfillmentTool(deps.reads.fulfillment),
      searchReturnsTool(deps.reads.returns),
      ...(deps.reads.insights ? insightTools(deps.reads.insights) : []),
      ...(deps.reads.inventory.get
        ? [getStockTool({ get: deps.reads.inventory.get })]
        : []),
      ...(deps.reads.fulfillment.get
        ? [getFulfillmentTool({ get: deps.reads.fulfillment.get })]
        : []),
      ...(deps.reads.customers ? [getCustomerTool(deps.reads.customers)] : []),
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
