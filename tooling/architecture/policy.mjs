// Consumer -> permitted providers. Keep ADR-001's table in sync.
export const connectorPackages = {
  'connector-core': [''],
  'connector-jtl': ['', 'schemas'],
  'connector-shopify': ['', 'schemas'],
};

export const dependencies = {
  platform: [],
  identity: ['platform'],
  audit: ['platform'],
  orders: ['platform', 'identity'],
  procurement: ['platform', 'identity', 'audit'],
  inventory: ['platform', 'identity'],
  connectors: ['platform', 'identity'],
  policies: ['platform', 'identity'],
  execution: ['platform', 'identity', 'policies', 'connectors', 'audit'],
  exceptions: ['platform', 'identity', 'orders', 'inventory'],
  commerce: ['connectors', 'identity', 'orders', 'inventory'],
  temporal: ['resolution', 'workflows', 'identity', 'platform'],
  workflows: ['platform', 'identity', 'policies', 'execution', 'connectors'],
  resolution: [
    'workflows',
    'platform',
    'identity',
    'orders',
    'inventory',
    'exceptions',
    'policies',
    'execution',
    'connectors',
    'audit',
  ],
};

export const layers = {
  domain: ['domain'],
  application: ['domain', 'application'],
  infrastructure: ['domain', 'application', 'infrastructure'],
  api: ['domain', 'application', 'api'],
  'index.ts': ['domain', 'application'],
  'http.ts': ['api', 'application', 'domain', 'composition.ts'],
  'adapters.ts': ['application', 'infrastructure'],
  'composition.ts': ['domain', 'application', 'infrastructure', 'index.ts'],
};

export const domainPackages = {
  platform: 'platform',
  identity: 'identity',
  audit: 'audit',
  orders: 'orders',
  procurement: 'procurement',
  inventory: 'inventory',
  connections: 'connectors',
  policies: 'policies',
  execution: 'execution',
  exceptions: 'exceptions',
  resolution: 'resolution',
  workflows: 'workflows',
  'commerce-ingestion': 'commerce',
  'workflow-temporal': 'temporal',
};
