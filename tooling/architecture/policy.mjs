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
  inventory: ['platform', 'identity'],
  connectors: ['platform', 'identity'],
  policies: ['platform', 'identity'],
  execution: ['platform', 'identity', 'policies', 'connectors', 'audit'],
  exceptions: ['platform', 'identity', 'orders', 'inventory'],
  workflows: [
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
  'composition.ts': [
    'domain',
    'application',
    'infrastructure',
    'api',
    'index.ts',
  ],
};
