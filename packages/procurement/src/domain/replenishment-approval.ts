import { canonicalJson } from '@luma/platform';

import { compareDecimals, orderValue, parseDecimal } from './order-value.js';
import type { PurchaseOrder } from './procurement.js';

interface Destination {
  connectionId: string;
  externalId: string;
  scopeKey: string;
}

/** Checks whether the original human review covers sending this unchanged replenishment draft. Missing evidence fails closed. */
export function replenishmentApprovalCoversSend(input: {
  order: PurchaseOrder;
  draft: {
    capability: string;
    target: { id: string };
    parameters: Record<string, unknown>;
  };
  grant: { requesterId: string; expiresAt: string };
  actorId: string;
  connectionId: string;
  supplierId: unknown;
  supplierScope: unknown;
  destination: Destination | null;
  rule: {
    separateSend: boolean;
    threshold: { amount: string; currency: string } | null;
  };
  now: number;
}): boolean {
  const { order, draft, grant, destination, rule } = input;
  if (
    rule.separateSend ||
    order.status !== 'draft' ||
    order.revision !== 1 ||
    order.authority !== 'luma' ||
    !order.origin.workflowRunId ||
    draft.capability !== 'procurement.purchase-order.create' ||
    draft.target.id !== order.id ||
    grant.requesterId !== input.actorId ||
    !Number.isFinite(Date.parse(grant.expiresAt)) ||
    Date.parse(grant.expiresAt) <= input.now ||
    !destination
  )
    return false;
  let lines: unknown, scope: unknown;
  try {
    lines = JSON.parse(String(draft.parameters.lines));
    scope = JSON.parse(String(draft.parameters.submissionScope));
  } catch {
    return false;
  }
  if (
    canonicalJson(lines) !== canonicalJson(order.lines) ||
    draft.parameters.supplierId !== order.supplierId ||
    draft.parameters.reference !== order.reference ||
    !scope ||
    canonicalJson(scope) !== canonicalJson(destination) ||
    destination.connectionId !== input.connectionId ||
    destination.externalId !== input.supplierId ||
    destination.scopeKey !== input.supplierScope
  )
    return false;
  if (rule.threshold) {
    const value = orderValue(order);
    if (
      !value ||
      value === 'unknown' ||
      value.currency !== rule.threshold.currency
    )
      return false;
    const total = parseDecimal(value.amount),
      limit = parseDecimal(rule.threshold.amount);
    if (!total || !limit || compareDecimals(total, limit) >= 0) return false;
  }

  return true;
}
