import { createHash } from 'node:crypto';

import type { AppFactoryContext } from '@luma/app-host';
import type { InstallationService } from '@luma/connections';
import type { TenantContext } from '@luma/identity';
import { ServiceError } from '@luma/platform';
import { compileProcessWorkflow } from '@luma/workflows/composition';

import { createShopifyCaseWorkflows } from './application/case-workflows.js';
import { createQuantityChangeWorkflow } from './application/quantity-change.js';
import {
  holdReleaseSource,
  quantityChangeSource,
  stockCorrectionSource,
} from './domain/case-workflows.js';
import type { createShopifyRecovery } from './fulfillment-recovery.js';
import { createCorrectionQuery } from './infrastructure/inventory-correction-query.js';
import type { createShopifyInventoryCorrection } from './inventory-correction.js';
import type { createShopifyOrderEdits } from './order-edits.js';

/**
 * Composes the Shopify case workflows over the app's governed correction, recovery and order
 * edit services. Workspaces without the Shopify app have no Shopify connections for these
 * workflows to use. The order quantity change reads plans and rereads orders through the host.
 */
export function createShopifyWorkflows(
  context: AppFactoryContext,
  services: {
    installations: InstallationService;
    recovery: ReturnType<typeof createShopifyRecovery>;
    corrections: ReturnType<typeof createShopifyInventoryCorrection>;
    edits: ReturnType<typeof createShopifyOrderEdits>;
  },
) {
  const query = createCorrectionQuery(
    context.database,
    context.sourceAuthority,
  );

  async function connections(tenant: TenantContext) {
    try {
      const version = await context.requireInstalled(tenant, 'shopify');
      const all = await services.installations.list(tenant);

      // Other apps' connections stay visible: stock correction needs the ERP source too.
      return all.filter(
        (item) =>
          item.appId !== 'shopify' || item.appInstallationVersion === version,
      );
    } catch (error) {
      if (
        error instanceof ServiceError &&
        [403, 404, 409].includes(error.statusCode)
      )
        return [];
      throw error;
    }
  }

  const id = (value: string) => {
    const hex = createHash('sha256').update(value).digest('hex');

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const now = () => new Date();

  return [
    ...createShopifyCaseWorkflows({
      corrections: services.corrections,
      recovery: services.recovery,
      position: query.position,
      connections,
      versions: {
        stock: compileProcessWorkflow(stockCorrectionSource),
        hold: compileProcessWorkflow(holdReleaseSource),
      },
      id,
      now,
    }),
    createQuantityChangeWorkflow({
      edits: services.edits,
      ...(context.orderChangePlans ? { plans: context.orderChangePlans } : {}),
      ...(context.refreshOrder ? { refresh: context.refreshOrder } : {}),
      connections,
      version: compileProcessWorkflow(quantityChangeSource),
      id,
      now,
    }),
  ];
}
