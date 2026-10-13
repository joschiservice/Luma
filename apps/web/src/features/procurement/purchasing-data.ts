import type {
  PurchasingPlanInput,
  PurchasingSettings,
} from '@luma/api-contract';
import { queryOptions } from '@tanstack/react-query';

import { privateQueryDefaults } from '../../lib/private-query';
import { createProcurementClient, procurementKey } from './data';

const api = createProcurementClient().procurement;

/** Reads server-side release availability and purchasing assumptions for this workspace. */
export const purchasingOptions = (organizationId: string, period?: number) =>
  queryOptions({
    queryKey: [...procurementKey(organizationId), 'purchasing', period],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      api.purchasingOverview(
        {
          params: { organizationId },
          query: period ? { demandPeriodDays: period } : {},
        },
        { signal },
      ),
  });

/** Reads saved decisions so approval work survives navigation and worker restarts. */
export const purchasingPlansOptions = (organizationId: string) =>
  queryOptions({
    queryKey: [...procurementKey(organizationId), 'purchasing-plans'],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      api.purchasingPlans({ params: { organizationId } }, { signal }),
  });

/** Saves workspace assumptions using the revision the operator reviewed. */
export const savePurchasingSettings = (
  organizationId: string,
  body: PurchasingSettings,
) => api.purchasingSettings({ params: { organizationId }, body });

/** Proposes a governed supplier draft with a stable ID and exact retry body. */
export const proposePurchasingPlan = (
  organizationId: string,
  body: PurchasingPlanInput,
) => api.purchasingPlan({ params: { organizationId }, body });

/** Responds to the persisted policy decision; the server resolves the requester for execution. */
export const decidePurchasingPlan = (
  organizationId: string,
  planId: string,
  body: { decisionId: string; outcome: 'approved' | 'rejected' },
) => api.purchasingDecision({ params: { organizationId, planId }, body });

/** Independently reconciles a saved draft without repeating a creation. */
export const checkPurchasingPlan = (organizationId: string, planId: string) =>
  api.purchasingReconcile({ params: { organizationId, planId }, body: {} });

/** Records an explicit ignored recommendation with a stable command ID. */
export const ignorePurchasingRecommendation = (
  organizationId: string,
  body: { id: string; supplierId: string; skuId: string; reason: string },
) => api.purchasingIgnore({ params: { organizationId }, body });

/** Resumes an already approved draft using its original persisted identity. */
export const executePurchasingPlan = (organizationId: string, planId: string) =>
  api.purchasingExecute({ params: { organizationId, planId }, body: {} });
