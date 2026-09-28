import type { WorkflowDetail, WorkflowRunView } from '@luma/api-contract';
import type { ComponentType } from 'react';

import { ReplenishmentPanel, ReplenishmentRunReview } from './replenishment';

interface WorkflowDomainView {
  triggerLabel: string;
  Controls: ComponentType<{ organizationId: string; detail: WorkflowDetail }>;
  RunContext: ComponentType<{ organizationId: string; run: WorkflowRunView }>;
}

const views: Record<string, WorkflowDomainView> = {
  'procurement.replenishment': {
    triggerLabel: 'Stock rules',
    Controls: ReplenishmentPanel,
    RunContext: ReplenishmentRunReview,
  },
};

/** Resolves optional domain controls; unregistered views retain standard workflow rendering. */
export function workflowDomainView(detail: WorkflowDetail) {
  return detail.presentation && Object.hasOwn(views, detail.presentation)
    ? views[detail.presentation]
    : undefined;
}
