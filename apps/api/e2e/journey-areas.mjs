/**
 * Maps backend and browser journeys to the source they exercise, so `pnpm test:affected` and
 * pull request CI run only journeys a change can affect. tooling/dev/affected.mjs adds modules
 * a journey imports by relative path; this file declares what journeys reach through the
 * running API, web app and workers. Prefer precise areas over shared paths: an unmapped change
 * runs every journey.
 */

/** Changes that cannot affect a journey's outcome. */
export const ignoredPaths = [
  '**/*.md',
  '**/*.test.{ts,tsx,mjs}',
  '**/test-support/**',
  '**/*.stories.tsx',
  '**/storybook-support.{ts,tsx}',
  'packages/ui/.storybook/**',
  '**/vitest.config.ts',
  '{apps,packages}/**/turbo.json',
  '**/.env.example',
  '.prettierignore',
  'knip.jsonc',
  'eslint.config.mjs',
  // Email previews for the React Email preview server.
  'packages/email/previews/**',
  // Marketing screenshot stories only.
  'apps/web/src/features/marketing/**',
  'tooling/{apps,architecture,benchmarks,orders,shopify,simulator,style}/**',
  'tooling/evaluation/*.mjs',
  // Generated from mapped sources.
  'apps/web/src/routeTree.gen.ts',
  'packages/api-contract/openapi.json',
];

/** Changes that can affect every journey. */
export const sharedPaths = [
  '**/package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'turbo.json',
  '**/tsconfig*.json',
  '.github/**',
  // Journey servers, the worker and the test runner.
  'apps/api/**',
  'apps/worker/**',
  'tooling/dev/**',
  // Every request passes through these services and policies.
  'packages/{platform,config,identity,identity-provider,audit,policies,execution,app-host,app-catalog,workflow-temporal}/**',
  'packages/application-runtime/src/*.ts',
  'packages/application-runtime/src/composition/{application,http-app,runtime-app,resources,services,admission,readiness}.ts',
  // Every journey applies the full migration chain.
  'packages/application-runtime/{migrations,scripts}/**',
  'packages/api-contract/src/{client,common,index,layout,openapi,routes}.ts',
  'packages/api-contract/src/contracts/{identity,system}.ts',
  'packages/i18n/src/**',
  'packages/i18n/messages/*/{common,layout,ui}.json',
  // The web shell, its platform kit and shared components.
  'apps/web/src/kit/**',
  'apps/web/src/shell/**',
  'packages/ui/**',
  'apps/web/src/lib/**',
  'apps/web/src/routes/{__root,app.$organizationId}.tsx',
  'apps/web/src/{router.tsx,server.ts,styles.css,home.tsx}',
  'apps/web/src/styles/**',
];

// Read models
const rmBase = [
  'packages/read-models/src/{composition,http,index}.ts',
  'packages/read-models/src/application/{access,records}.ts',
];
const rmOrders = [
  ...rmBase,
  'packages/read-models/src/api/orders.ts',
  'packages/read-models/src/application/{orders,order-authority,returns}.ts',
  'packages/read-models/src/infrastructure/orders/**',
  'packages/read-models/src/infrastructure/returns/list.ts',
];
const rmFulfillment = [
  ...rmBase,
  'packages/read-models/src/api/fulfillment.ts',
  'packages/read-models/src/application/{fulfillment,orders}.ts',
  'packages/read-models/src/infrastructure/fulfillment/**',
  'packages/read-models/src/infrastructure/orders/{identity-references,links,list-query,search-query,values}.ts',
];
const rmInsights = [
  ...rmBase,
  'packages/read-models/src/api/insights.ts',
  'packages/read-models/src/application/{insights,fulfillment,orders}.ts',
  'packages/read-models/src/domain/insights.ts',
  'packages/read-models/src/infrastructure/insights/**',
  'packages/read-models/src/infrastructure/fulfillment/rules.ts',
  'packages/read-models/src/infrastructure/orders/{list-query,search-query,values}.ts',
];
const rmInventory = [
  ...rmBase,
  'packages/read-models/src/api/inventory.ts',
  'packages/read-models/src/application/{inventory,transfers}.ts',
  'packages/read-models/src/domain/inventory.ts',
  'packages/read-models/src/infrastructure/inventory/**',
];
const rmProducts = [
  ...rmBase,
  'packages/read-models/src/api/products.ts',
  'packages/read-models/src/application/{products,inventory}.ts',
  'packages/read-models/src/domain/inventory.ts',
  'packages/read-models/src/infrastructure/products/**',
  'packages/read-models/src/infrastructure/inventory/positions.ts',
];
const rmProcurementContext = [
  ...rmBase,
  'packages/read-models/src/api/procurement.ts',
  'packages/read-models/src/application/{procurement,inventory}.ts',
  'packages/read-models/src/domain/inventory.ts',
  'packages/read-models/src/infrastructure/procurement/**',
  'packages/read-models/src/infrastructure/inventory/positions.ts',
];
const rmReturns = [
  ...rmBase,
  'packages/read-models/src/api/returns.ts',
  'packages/read-models/src/application/returns.ts',
  'packages/read-models/src/infrastructure/returns/**',
  'packages/read-models/src/infrastructure/orders/identity-references.ts',
];
const rmCustomers = [
  ...rmBase,
  'packages/read-models/src/api/customers.ts',
  'packages/read-models/src/application/customers.ts',
  'packages/read-models/src/infrastructure/customers/**',
];
const rmDecisions = [
  ...rmBase,
  'packages/read-models/src/api/decisions.ts',
  'packages/read-models/src/application/decisions.ts',
  'packages/read-models/src/domain/decision*.ts',
  'packages/read-models/src/infrastructure/decisions/**',
];
const rmMetrics = [
  ...rmBase,
  'packages/read-models/src/api/metrics.ts',
  'packages/read-models/src/application/{metrics,metric-pages,operational-summary}.ts',
  'packages/read-models/src/infrastructure/{metrics,metric-validation,operational-summary,operational-metric-validation}.ts',
];
const rmRecords = [
  ...rmBase,
  'packages/read-models/src/api/records.ts',
  'packages/read-models/src/infrastructure/record-explorer.ts',
  'packages/read-models/src/infrastructure/orders/identity-references.ts',
];

// Server areas
const connections = [
  'packages/connections/**',
  'packages/connectors/core/**',
  'packages/api-contract/src/**/{connections,providers}.ts',
];
const sourceAuthority = [
  ...connections,
  'packages/api-contract/src/**/authority.ts',
];
const commerce = [
  ...connections,
  'packages/commerce-ingestion/**',
  'packages/orders/**',
  'packages/inventory/**',
];
const syncWorker = [
  'packages/commerce-sync/**',
  'packages/customers/**',
  'packages/sales/**',
  'packages/application-runtime/src/composition/{commerce-sync,sales}.ts',
];
const detection = ['packages/exceptions/**', 'packages/resolution/**'];
// Email templates and their wording; identity sends them.
const email = ['packages/email/src/**', 'packages/i18n/messages/*/email.json'];
const cases = [
  ...detection,
  'packages/api-contract/src/**/{cases,desk,diagnosis,learning,overview,events}.ts',
];
const scheduledDetection = [
  ...detection,
  'packages/application-runtime/src/composition/detection-worker.ts',
];
const orderAttention = [
  'packages/exceptions/src/{composition,index}.ts',
  'packages/exceptions/src/infrastructure/cases.ts',
  'packages/resolution/src/{composition,index}.ts',
  'packages/resolution/src/**/activity*.ts',
];
const orders = [
  ...rmOrders,
  ...orderAttention,
  ...sourceAuthority,
  'packages/orders/**',
  'packages/api-contract/src/**/orders.ts',
];
const fulfillment = [
  ...rmFulfillment,
  ...orderAttention,
  'packages/orders/**',
  'packages/api-contract/src/**/fulfillment.ts',
];
const inventory = [
  ...rmInventory,
  'packages/inventory/**',
  'packages/api-contract/src/**/inventory.ts',
];
const products = [
  ...rmProducts,
  'packages/inventory/**',
  'packages/api-contract/src/**/products.ts',
];
const returns = [
  ...rmReturns,
  'packages/orders/**',
  'packages/api-contract/src/**/returns.ts',
];
const customers = [
  'packages/application-runtime/migrations/0087_return_service_reads.sql',
  ...rmCustomers,
  'packages/customers/**',
  'packages/api-contract/src/**/customers.ts',
];
const records = [...rmRecords, 'packages/api-contract/src/**/records.ts'];
const insights = [...rmInsights, 'packages/api-contract/src/**/insights.ts'];
const metrics = [
  ...rmMetrics,
  ...connections,
  'packages/orders/**',
  'packages/exceptions/**',
  'packages/resolution/**',
  'packages/api-contract/src/**/{metrics,metric-summary,events}.ts',
  'packages/application-runtime/src/infrastructure/metric-listener.ts',
];
const operationalMetrics = [
  ...metrics,
  'packages/procurement/**',
  'packages/api-contract/src/operational-metrics.ts',
];
const decisions = [
  'packages/application-runtime/migrations/0087_return_service_reads.sql',
  'packages/read-models/src/domain/return-case-decisions.ts',
  ...rmDecisions,
  'packages/resolution/**',
  'packages/api-contract/src/**/decisions.ts',
];
const activity = [
  'packages/resolution/**',
  'packages/api-contract/src/**/activity.ts',
];
const shadow = [
  'packages/resolution/**',
  'packages/api-contract/src/**/shadow.ts',
];
const measurement = [
  'packages/resolution/**',
  'packages/api-contract/src/**/{measurement,overview}.ts',
];
const playbooks = [
  'packages/resolution/**',
  'packages/workflows/**',
  'packages/api-contract/src/**/playbooks.ts',
  'packages/application-runtime/src/composition/playbook-library.ts',
];
const workflows = [...playbooks, 'packages/api-contract/src/**/workflows.ts'];
const drafts = [
  ...workflows,
  'packages/procurement/**',
  'packages/api-contract/src/**/{workflow-drafts,draft-tests}.ts',
];
const generation = [
  ...drafts,
  'packages/api-contract/src/**/workflow-generation.ts',
  'packages/application-runtime/src/composition/authoring.ts',
  'tooling/evaluation/fixtures/authoring-corpus.json',
];
const codeSteps = [
  ...workflows,
  'tooling/code-runtime/**',
  'packages/api-contract/src/code-steps.ts',
];
const caseWorkflows = [
  'packages/application-runtime/migrations/0092_refund_follow_up_cursors.sql',
  ...workflows,
  'packages/application-runtime/src/composition/case-workflows.ts',
];
const procurement = [
  ...rmProcurementContext,
  'packages/procurement/**',
  'packages/api-contract/src/**/{procurement,procurement-context}.ts',
  'packages/application-runtime/src/composition/{procurement-effects,procurement-submissions}.ts',
];
const replenishment = [
  ...procurement,
  ...workflows,
  'packages/application-runtime/src/composition/{replenishment,replenishment-worker}.ts',
  'packages/api-contract/src/replenishment.ts',
];
const supplierCommitments = [
  ...procurement,
  'packages/application-runtime/src/composition/supplier-follow-up.ts',
];
const sales = [
  'packages/sales/**',
  'packages/application-runtime/src/composition/sales.ts',
  'packages/api-contract/src/**/sales.ts',
];
const messaging = [
  'apps/web/src/shared/messaging/**',
  'packages/messaging/**',
  'packages/apps/gmail/**',
  'packages/connectors/gmail/**',
  'packages/api-contract/src/**/messaging.ts',
  'packages/application-runtime/src/composition/{mailbox-sync,messaging,messaging-documents,messaging-replies}.ts',
  'packages/read-models/src/domain/reply-decisions.ts',
  'packages/i18n/messages/*/{gmail,messaging}.json',
];
const returnCases = [
  'packages/application-runtime/src/composition/return-consistency.ts',
  'apps/api/e2e/return-completion-fixture.mjs',
  'packages/application-runtime/src/composition/return-exchanges.ts',
  'packages/api-contract/src/return-exchanges.ts',
  'apps/api/e2e/return-settlement-fixture.mjs',
  'packages/application-runtime/migrations/0088_return_settlement.sql',
  'packages/application-runtime/src/composition/return-settlement.ts',
  'packages/api-contract/src/return-actions.ts',
  'packages/application-runtime/migrations/0087_return_service_reads.sql',
  'packages/application-runtime/migrations/0086_return_creation_binding.sql',
  'packages/orders/**',
  'packages/api-contract/src/**/return-cases.ts',
  'packages/application-runtime/src/composition/return-cases.ts',
];
const sync = [
  'packages/commerce-sync/**',
  'packages/api-contract/src/**/sync.ts',
  'packages/application-runtime/src/composition/commerce-sync.ts',
];
const staff = [
  'apps/staff/**',
  'apps/staff-api/**',
  'packages/staff/**',
  'packages/api-contract/src/staff.ts',
];
// Home modules: activity, Needs you, overview, fulfillment, products, returns and live metrics.
const homeServer = [
  ...activity,
  ...decisions,
  ...cases,
  ...fulfillment,
  ...products,
  ...returns,
  ...metrics,
];
const temporalWorker = [
  'packages/application-runtime/src/composition/workflow-runtime.ts',
];
const replenishmentRuntime = [
  'packages/application-runtime/src/composition/{replenishment,replenishment-worker}.ts',
];

// Providers and synthetic environments
const shopify = [
  'packages/apps/shopify/**',
  'packages/connectors/shopify/**',
  'packages/i18n/messages/*/shopify.json',
];
const jtl = [
  'packages/apps/jtl/**',
  'packages/connectors/jtl/**',
  'packages/i18n/messages/*/jtl.json',
];
const cin7 = [
  'packages/apps/cin7/**',
  'packages/connectors/cin7/**',
  'packages/i18n/messages/*/cin7.json',
];
// e2e/connections-server.mjs installs the JTL and Shopify apps.
const appHost = [...connections, ...shopify, ...jtl];
// Services composed by the commerce, sync and detection fixtures.
const ordersFixture = [...commerce, ...syncWorker];
const detectionFixture = [...detection, 'packages/exceptions/fixtures/**'];
// tooling/pilot/runtime.mjs composes the API, detection, sync and exception workflows.
const pilot = [
  ...ordersFixture,
  ...scheduledDetection,
  ...cases,
  ...playbooks,
  ...activity,
  ...appHost,
  ...temporalWorker,
  'packages/application-runtime/src/infrastructure/metric-listener.ts',
];
// Simulated merchants also run an operations mailbox, which the sync worker reads.
const simulator = [
  ...pilot,
  ...messaging,
  'apps/simulator/**',
  'packages/simulator/**',
];

// Web
const webShell = [
  'apps/web/src/routes/{index,app,app.index,app.workspaces.index,app.workspaces.new,sign-in,sign-up,sign-out}.tsx',
  'apps/web/src/features/apps/navigation.tsx',
  'apps/web/src/features/assistant/**',
  'apps/web/src/features/decisions/data.ts',
  'apps/web/src/features/help/{article.tsx,context-help.tsx,context.ts,help-reader.tsx,search.tsx,source.ts}',
  'apps/web/src/features/{procurement,records}/data.ts',
  'packages/i18n/messages/*/{identity,permissions,apps,catalog,assistant,help,docs,procurement,settings}.json',
  'packages/api-contract/src/**/{decisions,apps,roles,settings}.ts',
  // The shell's Needs you badge reads decisions on every workspace page.
  ...rmDecisions,
];
const webExtensions = [
  'packages/apps/*/src/web/**',
  'apps/web/src/features/apps/extension.tsx',
];
const webHome = [
  'apps/web/src/features/activity/{data.ts,presentation.ts}',
  'apps/web/src/features/decisions/{data.ts,live.ts,presentation.ts}',
  'apps/web/src/features/exceptions/data.ts',
  'apps/web/src/features/fulfillment/{data.ts,presentation.ts}',
  'apps/web/src/shared/orders/presentation.ts',
  'apps/web/src/features/overview/data.ts',
  'apps/web/src/features/overview/metric-summary-data.ts',
  'apps/web/src/features/overview/metric-text.ts',
  'apps/web/src/features/overview/metrics-data.ts',
  'apps/web/src/features/overview/metrics-live.ts',
  'apps/web/src/features/overview/operational-metrics-data.ts',
  'apps/web/src/features/overview/operational-metrics.css',
  'apps/web/src/features/overview/operational-metrics.tsx',
  'apps/web/src/features/overview/order-metrics.css',
  'apps/web/src/features/overview/order-metrics.tsx',
  'apps/web/src/features/overview/resolution-evidence.tsx',
  'apps/web/src/features/products/{data.ts,presentation.ts}',
  'apps/web/src/features/returns/{data.ts,presentation.ts}',
  'apps/web/src/features/sync/presentation.ts',
  'apps/web/src/routes/app.$organizationId.home.tsx',
  'apps/web/src/routes/app.$organizationId.overview.tsx',
  'packages/i18n/messages/*/{activity,decisions,fulfillment,home,issues,metrics,orders,overview,products,returns,settings,sync}.json',
];
const webActivity = [
  'apps/web/src/features/activity/**',
  'apps/web/src/features/sync/presentation.ts',
  'apps/web/src/routes/app.$organizationId.activity.tsx',
  'packages/i18n/messages/*/{activity,connections,sync}.json',
];
const webApps = [
  'apps/web/src/features/apps/**',
  'apps/web/src/features/connections/**',
  'apps/web/src/features/sync/{data.ts,presentation.ts}',
  'apps/web/src/routes/app.$organizationId.{apps.*,connections.tsx}',
  'packages/i18n/messages/*/{apps,catalog,connections,issues,settings,sync}.json',
];
const webCustomers = [
  'apps/web/src/features/customers/**',
  'apps/web/src/features/orders/data.ts',
  'apps/web/src/features/orders/list-table.tsx',
  'apps/web/src/features/orders/orders.css',
  'apps/web/src/shared/orders/presentation.ts',
  'apps/web/src/features/products/presentation.ts',
  'apps/web/src/features/sync/{coverage.tsx,data.ts,presentation.ts,sync.css}',
  'apps/web/src/routes/app.$organizationId.customers.*',
  'packages/i18n/messages/*/{customers,issues,orders,products,sync}.json',
];
const webCases = [
  'apps/web/src/features/exceptions/**',
  'apps/web/src/features/overview/data.ts',
  'apps/web/src/features/exceptions/shadow/case.tsx',
  'apps/web/src/features/workflows/shadow/data.ts',
  'apps/web/src/features/workflows/shadow/result.tsx',
  'apps/web/src/features/exceptions/shadow/review-fields.tsx',
  'apps/web/src/features/exceptions/shadow/review.tsx',
  'apps/web/src/features/workflows/shadow/shadow.css',
  'apps/web/src/features/workflows/data.ts',
  'apps/web/src/routes/app.$organizationId.exceptions{,_}.*',
  'packages/i18n/messages/*/{connections,exceptions,settings,shadow,workflows}.json',
  // Case detail shows the change plan of the case's order.
  'apps/web/src/features/orders/{change-plan.tsx,data.ts,orders.css}',
  'apps/web/src/shared/orders/{order-section.tsx,presentation.ts}',
  'packages/i18n/messages/*/orders.json',
];
const webFulfillment = [
  'apps/web/src/features/activity/presentation.ts',
  'apps/web/src/features/apps/extension.tsx',
  'apps/web/src/features/fulfillment/**',
  'apps/web/src/shared/orders/presentation.ts',
  'apps/web/src/features/records/data.ts',
  'apps/web/src/features/sync/{coverage.tsx,data.ts,presentation.ts,sync.css}',
  'apps/web/src/routes/app.$organizationId.fulfillment.*',
  'packages/i18n/messages/*/{activity,apps,catalog,connections,fulfillment,issues,orders,settings,sync}.json',
];
const webInsights = [
  'apps/web/src/features/fulfillment/presentation.ts',
  'apps/web/src/features/insights/**',
  'apps/web/src/features/orders/data.ts',
  'apps/web/src/shared/orders/presentation.ts',
  'apps/web/src/features/overview/**',
  'apps/web/src/features/procurement/presentation.tsx',
  'apps/web/src/routes/app.$organizationId.insights.tsx',
  'packages/i18n/messages/*/{connections,fulfillment,insights,issues,metrics,orders,overview,procurement}.json',
];
const webInventory = [
  'apps/web/src/features/apps/extension.tsx',
  'apps/web/src/features/inventory/**',
  'apps/web/src/shared/orders/presentation.ts',
  'apps/web/src/features/records/data.ts',
  'apps/web/src/features/sync/{coverage.tsx,data.ts,identity-links.tsx,presentation.ts,sync.css}',
  'apps/web/src/features/workflows/{coverage.tsx,data.ts,readiness.css,readiness.tsx}',
  'apps/web/src/routes/app.$organizationId.inventory.*',
  'packages/i18n/messages/*/{apps,catalog,connections,inventory,issues,orders,settings,sync,workflows}.json',
];
const webNeedsYou = [
  'apps/web/src/features/apps/extension.tsx',
  'apps/web/src/features/decisions/**',
  'apps/web/src/features/exceptions/{data.ts,observation-data.ts,observation.ts,resolution-data.ts,resolution.tsx}',
  'apps/web/src/features/inventory/presentation.tsx',
  'apps/web/src/shared/orders/presentation.ts',
  'apps/web/src/features/procurement/{data.ts,detail.tsx,forms.tsx,presentation.tsx,procurement.css,record-dialogs.tsx}',
  'apps/web/src/features/workflows/{coverage.tsx,data.ts,readiness.css,readiness.tsx,replenishment-setup.tsx,replenishment.css,replenishment.tsx,workflows.css}',
  'apps/web/src/routes/app.$organizationId.needs-you.tsx',
  'packages/i18n/messages/*/{apps,catalog,connections,decisions,exceptions,inventory,issues,orders,procurement,settings,workflows}.json',
];
const webOrders = [
  'apps/web/src/features/activity/presentation.ts',
  'apps/web/src/features/apps/extension.tsx',
  'apps/web/src/features/orders/**',
  'apps/web/src/features/records/data.ts',
  'apps/web/src/features/returns/{order-returns.tsx,presentation.ts,returns.css}',
  'apps/web/src/features/sync/{coverage.tsx,data.ts,identity-links.tsx,presentation.ts,sync.css}',
  'apps/web/src/routes/app.$organizationId.orders.*',
  'packages/i18n/messages/*/{activity,apps,catalog,connections,issues,orders,records,returns,settings,sync}.json',
];
const webProcurement = [
  'apps/web/src/features/inventory/presentation.tsx',
  'apps/web/src/shared/orders/presentation.ts',
  'apps/web/src/features/procurement/**',
  'apps/web/src/features/workflows/{coverage.tsx,data.ts,readiness.css,readiness.tsx}',
  'apps/web/src/routes/app.$organizationId.procurement.*',
  'packages/i18n/messages/*/{inventory,issues,orders,procurement,workflows}.json',
];
const webProducts = [
  'apps/web/src/features/inventory/presentation.tsx',
  'apps/web/src/shared/orders/presentation.ts',
  'apps/web/src/features/products/**',
  'apps/web/src/features/records/data.ts',
  'apps/web/src/features/sync/{coverage.tsx,data.ts,identity-links.tsx,presentation.ts,sync.css}',
  'apps/web/src/routes/app.$organizationId.products.*',
  'packages/i18n/messages/*/{inventory,issues,orders,products,sync}.json',
];
const webRecords = [
  'apps/web/src/features/records/**',
  'apps/web/src/features/sync/presentation.ts',
  'apps/web/src/routes/app.$organizationId.records.*',
  'packages/i18n/messages/*/{connections,records,sync}.json',
];
const webReturns = [
  'apps/web/src/features/apps/extension.tsx',
  'apps/web/src/shared/orders/presentation.ts',
  'apps/web/src/features/records/data.ts',
  'apps/web/src/features/returns/**',
  'apps/web/src/features/sync/{coverage.tsx,data.ts,presentation.ts,sync.css}',
  'apps/web/src/routes/app.$organizationId.returns.*',
  'packages/i18n/messages/*/{apps,catalog,connections,issues,orders,returns,settings,sync}.json',
];
const webSettings = [
  'apps/web/src/features/orders/authority.ts',
  'apps/web/src/features/settings/**',
  'apps/web/src/routes/app.$organizationId.settings.$section.tsx',
  'apps/web/src/routes/app.$organizationId.settings.index.tsx',
  'apps/web/src/routes/app.invitations.$organizationId.$invitationId.tsx',
  'packages/i18n/messages/*/{home,issues,orders,settings}.json',
];
const webSync = [
  'apps/web/src/features/sync/**',
  'apps/web/src/routes/app.$organizationId.sync.tsx',
  'packages/i18n/messages/*/{connections,settings,sync}.json',
];
const webInbox = [
  'apps/web/src/features/inbox/**',
  'apps/web/src/routes/app.$organizationId.inbox.*',
  'packages/i18n/messages/*/messaging.json',
];
const webWorkflows = [
  'apps/web/src/features/workflows/shadow/data.ts',
  'apps/web/src/features/workflows/shadow/report.tsx',
  'apps/web/src/features/workflows/shadow/result.tsx',
  'apps/web/src/features/workflows/shadow/shadow.css',
  'apps/web/src/features/workflows/**',
  'apps/web/src/routes/app.$organizationId.{workflows,playbooks}.*',
  'packages/i18n/messages/*/{authoring,issues,settings,shadow,vocabulary,workflows}.json',
];
const webDocs = [
  'apps/web/src/features/help/**',
  'apps/web/src/routes/docs*',
  'apps/web/content/docs/**',
  'packages/i18n/messages/*/{docs,help}.json',
];
const webAuthRecovery = [
  'apps/web/src/routes/{forgot-password,reset-password}.tsx',
];

/** Source areas each journey exercises beyond the shared paths; `**` marks boot smoke tests. */
export const journeyAreas = {
  'activity.browser.mjs': [
    ...appHost,
    ...activity,
    ...cases,
    ...playbooks,
    ...webShell,
    ...webHome,
    ...webActivity,
    ...webCases,
  ],
  'adaptive-workspaces.browser.mjs': [
    'packages/adaptive/**',
    'packages/api-contract/src/adaptive*.ts',
    'packages/api-contract/src/contracts/adaptive*.ts',
    'packages/application-runtime/src/composition/adaptive.ts',
    'apps/web/src/features/adaptive/**',
    'apps/web/src/routes/app.$organizationId.views*.tsx',
    'packages/i18n/messages/*/adaptive.json',
    ...webShell,
    ...webHome,
    ...webOrders,
  ],
  'adaptive-workspaces.e2e.mjs': [
    'packages/adaptive/**',
    'packages/api-contract/src/adaptive*.ts',
    'packages/api-contract/src/contracts/adaptive*.ts',
    'packages/application-runtime/src/composition/adaptive.ts',
    'packages/read-models/src/infrastructure/orders/**',
  ],
  'activity.e2e.mjs': [...activity, ...cases, ...playbooks, ...connections],
  'approval-refresh.browser.mjs': [...pilot, ...webShell, ...webCases],
  'authentication-factors.browser.mjs': [
    ...webShell,
    ...webHome,
    ...webSettings,
  ],
  'automatic-links.browser.mjs': [
    ...commerce,
    ...sync,
    ...webShell,
    ...webSync,
  ],
  'automatic-links.e2e.mjs': [...commerce, ...sync],
  // Boot smoke: the built API composes every package, migrates and recovers execution.
  'backend.e2e.mjs': ['**'],
  'case-workflows.e2e.mjs': [
    ...simulator,
    ...caseWorkflows,
    ...decisions,
    ...supplierCommitments,
    ...replenishment,
  ],
  'cases.browser.mjs': [
    ...appHost,
    ...detectionFixture,
    ...cases,
    ...homeServer,
    ...webShell,
    ...webHome,
    ...webCases,
    ...webNeedsYou,
  ],
  'cin7.e2e.mjs': [...simulator, ...cin7, ...sync],
  'code-steps.browser.mjs': [
    ...appHost,
    ...codeSteps,
    ...webShell,
    ...webHome,
    ...webWorkflows,
  ],
  'code-steps.e2e.mjs': [...appHost, ...codeSteps],
  'connections.browser.mjs': [
    ...appHost,
    ...webShell,
    ...webHome,
    ...webApps,
    ...webExtensions,
  ],
  'customers.browser.mjs': [
    ...ordersFixture,
    ...customers,
    ...orders,
    ...records,
    ...shopify,
    ...webShell,
    ...webOrders,
    ...webCustomers,
    ...webExtensions,
  ],
  'customers.e2e.mjs': [...connections, ...customers],
  'decisions.browser.mjs': [
    ...simulator,
    ...replenishment,
    ...decisions,
    ...metrics,
    ...homeServer,
    ...webShell,
    ...webHome,
    ...webNeedsYou,
  ],
  'decisions.e2e.mjs': [...simulator, ...replenishment, ...decisions, ...cases],
  'docs.browser.mjs': [...webDocs],
  'action-diffs.e2e.mjs': [...detection, ...connections],
  'action-diffs.browser.mjs': [
    ...detection,
    ...connections,
    'apps/web/src/features/decisions/**',
    'apps/web/src/features/workflows/**',
  ],
  'morning-brief.e2e.mjs': [...email, ...detection],
  'email.e2e.mjs': [...email, ...detection],
  'fulfillment.browser.mjs': [
    ...ordersFixture,
    ...detectionFixture,
    ...fulfillment,
    ...orders,
    ...webShell,
    ...webHome,
    ...webFulfillment,
    ...webOrders,
  ],
  'fulfillment.e2e.mjs': [
    ...ordersFixture,
    ...detectionFixture,
    ...fulfillment,
  ],
  'identity.browser.mjs': [
    ...cases,
    ...connections,
    ...webShell,
    ...webHome,
    ...webCases,
    ...webSettings,
    ...webApps,
  ],
  'inbox.browser.mjs': [
    ...simulator,
    ...procurement,
    ...decisions,
    ...webShell,
    ...webInbox,
    ...webNeedsYou,
  ],
  'purchasing-cycle.e2e.mjs': [
    'apps/api/e2e/purchasing-reconciliation-worker.mjs',
    ...simulator,
    ...procurement,
    ...decisions,
    ...inventory,
    'packages/api-contract/src/**/{supplier-email,supplier-terms,purchasing,incoming-stock}.ts',
  ],
  'purchase-order-changes.e2e.mjs': [
    ...simulator,
    ...procurement,
    ...decisions,
    ...jtl,
    'packages/api-contract/src/**/purchase-order-changes.ts',
    'packages/application-runtime/src/composition/purchase-order-changes.ts',
  ],
  'native-purchase-incoming.e2e.mjs': [
    ...simulator,
    ...procurement,
    ...decisions,
    ...inventory,
    'packages/inventory/**',
    'packages/application-runtime/src/composition/native-purchase-incoming.ts',
  ],
  'purchasing-native-receipt.e2e.mjs': [
    ...simulator,
    ...procurement,
    ...decisions,
    ...inventory,
    'packages/inventory/**',
    'packages/application-runtime/src/composition/native-stock.ts',
  ],
  'inbox.e2e.mjs': [...simulator, ...procurement, ...decisions],
  'contextual-assistance.browser.mjs': [
    ...ordersFixture,
    ...detectionFixture,
    ...orders,
    ...fulfillment,
    ...inventory,
    ...customers,
    ...insights,
    ...webShell,
    ...webInsights,
    'packages/assistant/**',
    'packages/api-contract/src/assistant.ts',
    'packages/application-runtime/src/composition/assistant.test.ts',
    'apps/web/src/kit/record-assistance.tsx',
    'apps/web/src/lib/assistant-panel.ts',
    'apps/web/src/features/{orders,inventory,fulfillment,customers,exceptions}/**',
    'apps/web/src/features/insights/records.tsx',
  ],
  'insights.browser.mjs': [
    ...ordersFixture,
    ...detectionFixture,
    ...insights,
    ...orders,
    ...metrics,
    ...webShell,
    ...webInsights,
    ...webOrders,
  ],
  'insights.e2e.mjs': [
    ...ordersFixture,
    ...detectionFixture,
    ...insights,
    ...orders,
    ...fulfillment,
    ...procurement,
    ...metrics,
  ],
  'inventory.browser.mjs': [
    ...ordersFixture,
    ...detectionFixture,
    ...inventory,
    ...orders,
    ...cases,
    ...workflows,
    ...webShell,
    ...webCases,
    ...webInventory,
    ...webOrders,
  ],
  'native-stock.browser.mjs': [
    ...ordersFixture,
    ...orders,
    ...inventory,
    ...appHost,
    ...webShell,
    ...webOrders,
    ...webInventory,
    'apps/api/e2e/native-stock-fixture.mjs',
    'apps/api/e2e/stock-ledger-fixture.mjs',
    'packages/application-runtime/src/composition/native-stock.ts',
    'packages/application-runtime/src/composition/sales.ts',
    'packages/sales/**',
  ],
  'native-publication.e2e.mjs': [
    ...ordersFixture,
    ...orders,
    ...inventory,
    ...shopify,
    ...appHost,
    'packages/sales/**',
    'packages/application-runtime/src/composition/native-stock.ts',
  ],
  'native-publication.browser.mjs': [
    ...ordersFixture,
    ...orders,
    ...inventory,
    ...shopify,
    ...appHost,
    ...webShell,
    ...webInventory,
    'packages/sales/**',
    'packages/application-runtime/src/composition/native-stock.ts',
  ],
  'native-stock.e2e.mjs': [
    'apps/api/e2e/native-stock-fixture.mjs',
    'apps/api/e2e/stock-ledger-fixture.mjs',
    ...ordersFixture,
    ...orders,
    ...inventory,
    ...appHost,
    'packages/application-runtime/src/composition/native-stock.ts',
    'packages/application-runtime/src/composition/sales.ts',
    'packages/sales/**',
  ],
  'stock-ledger.e2e.mjs': [
    'apps/api/e2e/stock-ledger-fixture.mjs',
    ...ordersFixture,
    ...inventory,
    ...appHost,
    'packages/application-runtime/src/composition/inventory-ledger.ts',
  ],
  'shopify-bundles.e2e.mjs': [
    ...ordersFixture,
    ...detectionFixture,
    ...orders,
    ...products,
    ...inventory,
    ...returns,
    ...appHost,
  ],
  'shopify-bundles.browser.mjs': [
    ...ordersFixture,
    ...detectionFixture,
    ...orders,
    ...products,
    ...inventory,
    ...returns,
    ...appHost,
    ...webShell,
    ...webOrders,
    ...webProducts,
  ],
  'shopify-transfers.e2e.mjs': [
    ...ordersFixture,
    ...detectionFixture,
    ...inventory,
    ...procurement,
    ...appHost,
  ],
  'shopify-transfers.browser.mjs': [
    ...ordersFixture,
    ...detectionFixture,
    ...inventory,
    ...procurement,
    ...appHost,
    ...webShell,
    ...webInventory,
  ],
  'inventory.e2e.mjs': [
    ...ordersFixture,
    ...detectionFixture,
    ...inventory,
    ...procurement,
  ],
  'issues-help.browser.mjs': [
    ...appHost,
    ...detectionFixture,
    ...cases,
    ...webShell,
    ...webHome,
    ...webCases,
    ...webDocs,
  ],
  'metric-live.browser.mjs': [
    ...commerce,
    ...metrics,
    ...insights,
    ...webShell,
    ...webInsights,
  ],
  'metric-stream.e2e.mjs': [...commerce, ...metrics],
  'metrics.browser.mjs': [
    ...commerce,
    ...metrics,
    ...insights,
    ...webShell,
    ...webInsights,
  ],
  'operational-metrics.browser.mjs': [
    ...operationalMetrics,
    ...procurement,
    ...cases,
    ...insights,
    ...webShell,
    ...webInsights,
  ],
  'operational-metrics.e2e.mjs': [
    ...operationalMetrics,
    ...procurement,
    ...cases,
  ],
  'order-change-plan.browser.mjs': [
    ...simulator,
    ...sync,
    ...orders,
    ...shopify,
    ...jtl,
    ...webShell,
    ...webOrders,
    ...webExtensions,
  ],
  'order-change-plan.e2e.mjs': [
    ...simulator,
    ...sync,
    ...orders,
    ...shopify,
    ...jtl,
  ],
  'order-quantity-change.browser.mjs': [
    ...simulator,
    ...sync,
    ...orders,
    ...sales,
    ...shopify,
    ...jtl,
    ...caseWorkflows,
    ...decisions,
    ...webShell,
    ...webCases,
    ...webNeedsYou,
    ...webOrders,
  ],
  'order-quantity-change.e2e.mjs': [
    ...simulator,
    ...sync,
    ...orders,
    ...sales,
    ...shopify,
    ...jtl,
    ...caseWorkflows,
    ...decisions,
  ],
  'order-links.browser.mjs': [
    ...ordersFixture,
    ...orders,
    ...sync,
    ...webShell,
    ...webOrders,
  ],
  'order-journey.e2e.mjs': [...ordersFixture, ...orders, ...inventory],
  'order-journey.browser.mjs': [
    ...ordersFixture,
    ...orders,
    ...inventory,
    ...webShell,
    ...webOrders,
  ],
  'orders.browser.mjs': [
    ...ordersFixture,
    ...orders,
    ...sales,
    ...webShell,
    ...webHome,
    ...webOrders,
  ],
  'password-security.browser.mjs': [
    ...email,
    ...webShell,
    ...webHome,
    ...webSettings,
    ...webAuthRecovery,
  ],
  'password-security.e2e.mjs': [
    ...email,
    'packages/i18n/messages/*/identity.json',
  ],
  // The pilot process is spawned by path, so it is outside the import closure.
  'pilot.e2e.mjs': [
    ...pilot,
    ...replenishmentRuntime,
    'tooling/pilot/process.mjs',
    'tooling/observability/**',
  ],
  'playbooks.browser.mjs': [
    ...appHost,
    ...workflows,
    ...webShell,
    ...webHome,
    ...webWorkflows,
  ],
  'playbooks.e2e.mjs': [...connections, ...workflows],
  'procurement.browser.mjs': [
    ...procurement,
    ...activity,
    ...webShell,
    ...webProcurement,
    ...webActivity,
  ],
  'purchasing-workbench.browser.mjs': [
    ...simulator,
    ...procurement,
    ...decisions,
    ...inventory,
    ...webShell,
    ...webProcurement,
    'packages/api-contract/src/**/{supplier-terms,purchasing,incoming-stock}.ts',
  ],
  'procurement.e2e.mjs': [...procurement, ...activity],
  'products.browser.mjs': [
    ...ordersFixture,
    ...detectionFixture,
    ...products,
    ...inventory,
    ...orders,
    ...workflows,
    ...webShell,
    ...webOrders,
    ...webProducts,
    ...webInventory,
  ],
  'products.e2e.mjs': [
    ...ordersFixture,
    ...detectionFixture,
    ...products,
    ...inventory,
  ],
  'records.browser.mjs': [
    ...commerce,
    ...records,
    ...metrics,
    ...insights,
    ...orders,
    ...webShell,
    ...webRecords,
    ...webInsights,
    ...webOrders,
  ],
  'replenishment.browser.mjs': [
    ...simulator,
    ...replenishment,
    ...activity,
    ...inventory,
    ...decisions,
    ...webShell,
    ...webWorkflows,
    ...webActivity,
    ...webProcurement,
    ...webInventory,
    ...webExtensions,
  ],
  'replenishment.e2e.mjs': [
    ...simulator,
    ...replenishment,
    ...decisions,
    ...activity,
  ],
  'resolution-measurement.browser.mjs': [
    ...measurement,
    ...cases,
    ...metrics,
    ...insights,
    ...webShell,
    ...webInsights,
  ],
  'resolution-measurement.e2e.mjs': [
    ...measurement,
    ...cases,
    ...metrics,
    ...connections,
  ],
  'resolution-reporting.e2e.mjs': [
    ...measurement,
    ...cases,
    ...metrics,
    ...connections,
  ],
  'resolution-reporting.browser.mjs': [
    ...measurement,
    ...cases,
    ...metrics,
    ...insights,
    ...webShell,
    ...webInsights,
  ],
  'resolution.browser.mjs': [
    ...appHost,
    ...detectionFixture,
    ...cases,
    ...webShell,
    ...webHome,
    ...webCases,
  ],
  'return-settlement.browser.mjs': [
    'apps/api/e2e/return-browser-commands.mjs',
    ...simulator,
    ...returns,
    ...returnCases,
    ...decisions,
    ...commerce,
    ...webShell,
    ...webReturns,
  ],
  'return-exchange.browser.mjs': [
    'apps/api/e2e/return-browser-commands.mjs',
    ...simulator,
    ...returns,
    ...returnCases,
    ...decisions,
    ...commerce,
    ...webShell,
    ...webReturns,
  ],
  'return-completion.e2e.mjs': [
    ...simulator,
    ...returns,
    ...returnCases,
    ...decisions,
    ...commerce,
  ],
  'return-completion.browser.mjs': [
    'apps/api/e2e/return-browser-commands.mjs',
    ...simulator,
    ...returns,
    ...returnCases,
    ...decisions,
    ...commerce,
    ...webShell,
    ...webReturns,
  ],
  'return-deadlines.e2e.mjs': [
    ...simulator,
    ...returns,
    ...returnCases,
    ...decisions,
    ...commerce,
  ],
  'return-deadlines.browser.mjs': [
    ...simulator,
    ...returns,
    ...returnCases,
    ...decisions,
    ...commerce,
    ...webShell,
    ...webReturns,
  ],
  'return-exchange.e2e.mjs': [
    ...simulator,
    ...returns,
    ...returnCases,
    ...decisions,
    ...commerce,
  ],
  'return-settlement.e2e.mjs': [
    ...simulator,
    ...returns,
    ...returnCases,
    ...decisions,
    ...commerce,
  ],
  'return-cases.e2e.mjs': [
    ...simulator,
    ...returns,
    ...returnCases,
    ...decisions,
  ],
  'returns.browser.mjs': [
    ...returnCases,
    ...customers,
    ...decisions,
    ...webCustomers,
    ...webNeedsYou,
    ...commerce,
    ...returns,
    ...orders,
    ...webShell,
    ...webOrders,
    ...webReturns,
    ...webExtensions,
  ],
  'returns.e2e.mjs': [...commerce, ...returns, ...orders],
  'roles.browser.mjs': [
    ...inventory,
    ...webShell,
    ...webHome,
    ...webSettings,
    ...webInventory,
  ],
  'sales.browser.mjs': [
    ...ordersFixture,
    ...orders,
    ...sales,
    ...sourceAuthority,
    ...webShell,
    ...webOrders,
  ],
  'seed.e2e.mjs': [...detectionFixture],
  'settings.browser.mjs': [
    ...email,
    ...homeServer,
    ...webShell,
    ...webHome,
    ...webSettings,
  ],
  'scoped-autonomy.e2e.mjs': [
    ...simulator,
    ...caseWorkflows,
    ...decisions,
    ...supplierCommitments,
    'packages/policies/**',
    'packages/execution/**',
    'packages/api-contract/src/*scoped*',
    'packages/api-contract/src/contracts/*scoped*',
    'packages/application-runtime/src/composition/scoped-follow-up.ts',
  ],
  'settings.e2e.mjs': [...detection, ...connections, ...email],
  'shadow.browser.mjs': [
    ...appHost,
    ...detectionFixture,
    ...cases,
    ...shadow,
    ...workflows,
    ...webShell,
    ...webHome,
    ...webCases,
    ...webWorkflows,
  ],
  'shopify-fulfillment.browser.mjs': [
    ...connections,
    ...shopify,
    ...webShell,
    ...webApps,
    ...webExtensions,
  ],
  'shopify-shipment-publishing.browser.mjs': [
    'apps/api/e2e/shopify-shipment-publishing-fixture.mjs',
    ...connections,
    ...shopify,
    ...ordersFixture,
    ...rmFulfillment,
    ...webShell,
    ...webApps,
    ...webExtensions,
    'packages/apps/starshipit/**',
    'packages/connectors/starshipit/**',
    'packages/simulator/{core,shopify,starshipit}/**',
  ],
  'shopify-shipment-publishing.e2e.mjs': [
    'apps/api/e2e/shopify-shipment-publishing-fixture.mjs',
    ...connections,
    ...shopify,
    ...ordersFixture,
    ...rmFulfillment,
    'packages/apps/starshipit/**',
    'packages/connectors/starshipit/**',
    'packages/simulator/{core,shopify,starshipit}/**',
  ],
  'shopify-fulfillment.e2e.mjs': [...connections, ...shopify],
  'shopify-inventory.browser.mjs': [
    ...ordersFixture,
    ...detectionFixture,
    ...inventory,
    ...shopify,
    ...jtl,
    'packages/simulator/{core,shopify}/**',
    ...webShell,
    ...webInventory,
    ...webExtensions,
  ],
  'shopify-inventory.e2e.mjs': [
    ...ordersFixture,
    ...detectionFixture,
    ...inventory,
    ...shopify,
    ...jtl,
    ...decisions,
    ...sourceAuthority,
    'packages/simulator/{core,shopify}/**',
  ],
  'shopify-order-edits.browser.mjs': [
    ...shopify,
    ...sourceAuthority,
    // Propagated edits read the authoritative source's stored order lines.
    ...rmOrders,
    'packages/simulator/{core,shopify}/**',
    ...webShell,
    ...webApps,
    ...webExtensions,
  ],
  'shopify-order-edits.e2e.mjs': [
    ...shopify,
    ...decisions,
    ...sourceAuthority,
    // Propagated edits read the authoritative source's stored order lines.
    ...rmOrders,
    'packages/simulator/{core,shopify}/**',
  ],
  'simulator.browser.mjs': [...simulator, 'apps/simulator-web/**'],
  'order-line-links.e2e.mjs': [
    'apps/api/e2e/starshipit-operations-fixture.mjs',
    ...simulator,
    ...sync,
    ...orders,
    ...connections,
  ],
  'starshipit.browser.mjs': [
    'apps/api/e2e/starshipit-operations-fixture.mjs',
    ...simulator,
    ...sync,
    ...orders,
    ...connections,
    ...webOrders,
  ],
  'starshipit-updates.e2e.mjs': [
    'apps/api/e2e/starshipit-updates-fixture.mjs',
    'apps/api/e2e/shopify-shipment-publishing-fixture.mjs',
    ...connections,
    ...simulator,
    ...ordersFixture,
    ...rmFulfillment,
    'packages/apps/starshipit/**',
    'packages/connectors/starshipit/**',
    'packages/simulator/{core,shopify,starshipit}/**',
  ],
  'starshipit-simulator.e2e.mjs': [...simulator, ...sync, ...connections],
  'simulator.e2e.mjs': [
    ...simulator,
    ...sync,
    ...customers,
    ...orders,
    ...metrics,
  ],
  'source-authority.browser.mjs': [
    ...ordersFixture,
    ...orders,
    ...sourceAuthority,
    ...webShell,
    ...webSettings,
    ...webOrders,
  ],
  'staff.browser.mjs': [
    ...staff,
    ...activity,
    ...sync,
    ...connections,
    ...webShell,
    ...webActivity,
  ],
  'supplier-commitments.browser.mjs': [
    ...simulator,
    ...supplierCommitments,
    ...decisions,
    ...webShell,
    ...webProcurement,
    ...webNeedsYou,
  ],
  'supplier-commitments.e2e.mjs': [
    ...simulator,
    ...supplierCommitments,
    ...decisions,
  ],
  'support-view.browser.mjs': [
    ...staff,
    ...activity,
    ...webShell,
    ...webHome,
    ...webSettings,
    ...webActivity,
    'apps/web/src/routes/support-view.tsx',
  ],
  'sync.browser.mjs': [
    ...connections,
    ...sync,
    ...orders,
    ...webShell,
    ...webOrders,
    ...webSync,
  ],
  'sync.e2e.mjs': [...connections, ...sync],
  // Boot smoke: the standalone worker composes every service and Temporal worker.
  'worker.e2e.mjs': ['**'],
  'workflow-authoring.browser.mjs': [
    ...generation,
    ...webShell,
    ...webHome,
    ...webWorkflows,
  ],
  'workflow-improvements.browser.mjs': [
    ...generation,
    ...webShell,
    ...webHome,
    ...webWorkflows,
    ...detection,
  ],
  'workflow-describe.browser.mjs': [
    ...generation,
    ...webShell,
    ...webHome,
    ...webWorkflows,
  ],
  'workflow-draft-tests.e2e.mjs': [...drafts],
  'workflow-drafts.e2e.mjs': [...drafts],
  'workflow-generation.e2e.mjs': [...generation],
  'workflow-improvement-controls.e2e.mjs': [
    ...generation,
    ...workflows,
    ...detection,
    'packages/workflow-temporal/**',
  ],
  'workflow-triggers.browser.mjs': [
    ...appHost,
    ...workflows,
    ...webShell,
    ...webHome,
    ...webWorkflows,
  ],
  'workflow-coordination.browser.mjs': [
    ...connections,
    ...workflows,
    ...decisions,
    ...webWorkflows,
    ...webNeedsYou,
  ],
  'workflow-coordination.e2e.mjs': [...connections, ...workflows, ...decisions],
  'workflows.e2e.mjs': [...connections, ...workflows],
};
