export type {
  AppDefinition,
  AppFactoryContext,
  AppFactory,
  AppManifest,
  WorkspaceApp,
  AppLifecycleContext,
} from './application/contracts.js';

export { createAppRegistry } from './application/registry.js';

export type { AppRegistry } from './application/registry.js';

export { createAppService } from './composition.js';

export type { AppService } from './application/installations.js';
