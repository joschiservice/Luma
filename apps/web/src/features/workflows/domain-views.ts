import type { WorkflowDetail, WorkflowRunView } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import type { ComponentType } from 'react';

import { CaseRunContext, CaseWorkflowAction, CaseWorkflowPanel } from './case';
import { ReplenishmentPanel, ReplenishmentRunReview } from './replenishment';

interface WorkflowDomainView {
  /** Rule controls; `setup` preselects a record when another page links to setup. */
  Controls: ComponentType<{
    organizationId: string;
    detail: WorkflowDetail;
    setup?: string | undefined;
  }>;
  RunContext: ComponentType<{ organizationId: string; run: WorkflowRunView }>;
  /** The page's primary control, such as turning the workflow on; `notify` reports the result. */
  Action?: ComponentType<{
    organizationId: string;
    detail: WorkflowDetail;
    notify: (message: string) => void;
  }>;
  /** Names the setup tab when the domain's controls are better known by another name. */
  setupLabel?: () => string;
}

const views: Record<string, WorkflowDomainView> = {
  'procurement.replenishment': {
    Controls: ReplenishmentPanel,
    RunContext: ReplenishmentRunReview,
    setupLabel: m.workflows_detail_tab_stock_rules,
  },
  'workflows.case': {
    Controls: CaseWorkflowPanel,
    RunContext: CaseRunContext,
    Action: CaseWorkflowAction,
  },
};

/** Resolves optional domain controls; unregistered views retain standard workflow rendering. */
export function workflowDomainView(detail: WorkflowDetail) {
  return detail.presentation && Object.hasOwn(views, detail.presentation)
    ? views[detail.presentation]
    : undefined;
}
