import type { createAppHost } from '@luma/app-catalog';
import type { ModelGatewayConfig } from '@luma/config';
import {
  createInstalledMessageRuntime,
  createInstalledPurchaseOrderRuntime,
  createInstalledReturnRuntime,
  createInstalledRuntime,
} from '@luma/connections/composition';
import type { ModelGateway, Observability } from '@luma/platform';

import type { ApplicationOptions } from './application.js';
import {
  assistantAvailability,
  authoringAvailability,
  documentExtractionAvailability,
  supplierExtractionAvailability,
} from './authoring.js';

type AppHost = Pick<
  ReturnType<typeof createAppHost>,
  | 'connections'
  | 'registry'
  | 'providerCatalog'
  | 'connectionEnvironment'
  | 'decisionSources'
>;

/** The options every runtime derives the same way from its app host and process settings. */
export type HostApplicationOptions = Pick<
  ApplicationOptions,
  | 'providerCatalog'
  | 'connectionEnvironment'
  | 'decisionSources'
  | 'evidenceSources'
  | 'workflowSources'
  | 'actionPermission'
  | 'nativeStockReader'
  | 'purchasing'
  | 'returns'
  | 'messaging'
  | 'modelGateway'
  | 'authoring'
  | 'supplierExtraction'
  | 'assistant'
  | 'documentExtraction'
  | 'observability'
>;

/**
 * Derives application options from an installed app host, so the API, the workflow worker,
 * mailbox sync and supplier follow-up compose services alike: installed apps' decisions and case
 * workflows, provider reads for active diagnosis, purchase-order, return and mailbox runtimes,
 * and model routes with their availability. Process-specific options (execution, workflow
 * transport, desk reader, stock refresh, timing) stay with each runtime.
 *
 * Provider runtimes record no telemetry: owners keep the observations they use as evidence.
 * Without `providerRuntimes`, purchase orders, returns and mailboxes stay local; the API uses
 * that when it runs without connection settings. Without `model`, every model-backed feature
 * reports that model routes aren't configured.
 */
export function applicationOptionsFor(
  host: AppHost,
  settings: {
    providerRuntimes?: boolean;
    model?: { gateway: ModelGateway; settings: ModelGatewayConfig };
    observability?: Observability;
  } = {},
): HostApplicationOptions {
  const runtime = {
    installations: host.connections,
    providers: host.registry.providers(),
    record: async () => undefined,
    recordObservations: async () => undefined,
  };
  const mailbox = createInstalledMessageRuntime(runtime);
  const model = settings.model;

  return {
    providerCatalog: host.providerCatalog,
    connectionEnvironment: host.connectionEnvironment,
    decisionSources: host.decisionSources(),
    evidenceSources: host.registry.evidenceSources(),
    workflowSources: host.registry.workflowSources(),
    actionPermission: host.registry.actionPermission,
    nativeStockReader: createInstalledRuntime(runtime),
    ...(settings.providerRuntimes === false
      ? {}
      : {
          purchasing: {
            runtime: createInstalledPurchaseOrderRuntime(runtime),
            installations: host.connections,
          },
          returns: {
            runtime: createInstalledReturnRuntime(runtime),
            installations: host.connections,
          },
          // Mailboxes are listed from installed connections and threads reread on demand;
          // replies are sent through the same runtime when execution is enabled.
          messaging: {
            installations: host.connections,
            reader: mailbox,
            sender: mailbox,
          },
        }),
    ...(model ? { modelGateway: model.gateway } : {}),
    authoring: authoringAvailability(model?.settings, !!model),
    supplierExtraction: supplierExtractionAvailability(
      model?.settings,
      !!model,
    ),
    assistant: assistantAvailability(model?.settings, !!model),
    documentExtraction: documentExtractionAvailability(
      model?.settings,
      !!model,
    ),
    ...(settings.observability
      ? { observability: settings.observability }
      : {}),
  };
}
