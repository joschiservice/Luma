import type { WorkflowDetail, WorkflowRunView } from '@luma/api-contract';
import type { ComponentType } from 'react';

import { CaseRunContext, CaseWorkflowPanel } from './case';
import { ReplenishmentPanel, ReplenishmentRunReview } from './replenishment';

interface WorkflowDomainView {
  /** Rule controls; `setup` preselects a record when another page links to setup. */
  Controls: ComponentType<{
    organizationId: string;
    detail: WorkflowDetail;
    setup?: string | undefined;
  }>;
  RunContext: ComponentType<{ organizationId: string; run: WorkflowRunView }>;
}

const views: Record<string, WorkflowDomainView> = {
  'procurement.replenishment': {
    Controls: ReplenishmentPanel,
    RunContext: ReplenishmentRunReview,
  },
  'workflows.case': {
    Controls: CaseWorkflowPanel,
    RunContext: CaseRunContext,
  },
};

/** Resolves optional domain controls; unregistered views retain standard workflow rendering. */
export function workflowDomainView(detail: WorkflowDetail) {
  return detail.presentation && Object.hasOwn(views, detail.presentation)
    ? views[detail.presentation]
    : undefined;
}
