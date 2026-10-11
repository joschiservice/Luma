// Consumer -> permitted providers. Keep ADR-001's table in sync.
export const connectorPackages = {
  'connector-core': [''],
  'connector-jtl': ['', 'schemas'],
  'connector-shopify': ['', 'schemas'],
};

export const dependencies = {
  platform: [],
  identity: ['platform'],
  federation: [],
  staff: ['platform', 'identity', 'federation'],
  audit: ['platform'],
  orders: ['platform', 'identity'],
  procurement: [
    'platform',
    'identity',
    'audit',
    'connectors',
    'execution',
    'policies',
    'workflows',
  ],
  // Reads mailboxes through composed ports; other owners' records only through ports.
  messaging: ['platform', 'identity', 'audit'],
  inventory: ['platform', 'identity'],
  customers: ['platform', 'identity'],
  connectors: ['platform', 'identity'],
  policies: ['platform', 'identity'],
  execution: ['platform', 'identity', 'policies', 'connectors', 'audit'],
  exceptions: ['platform', 'identity', 'orders', 'inventory'],
  commerce: ['connectors', 'identity', 'orders', 'inventory'],
  // Schedules reads through installed connections and projects through commerce owners.
  sync: ['platform', 'identity', 'connectors', 'commerce', 'customers'],
  temporal: ['resolution', 'workflows', 'identity', 'platform'],
  workflows: ['platform', 'identity', 'policies', 'execution', 'connectors'],
  resolution: [
    'procurement',
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
  // Read-only workspace views. Business rules come from their owners; see ADR-008.
  reads: [
    'resolution',
    'platform',
    'identity',
    'orders',
    'exceptions',
    'connectors',
    'procurement',
  ],
  // Answers questions through read-only tools over owners' read services.
  assistant: ['platform', 'identity', 'reads', 'exceptions'],
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
  'identity-provider': 'federation',
  staff: 'staff',
  audit: 'audit',
  orders: 'orders',
  procurement: 'procurement',
  messaging: 'messaging',
  inventory: 'inventory',
  connections: 'connectors',
  policies: 'policies',
  execution: 'execution',
  exceptions: 'exceptions',
  resolution: 'resolution',
  'read-models': 'reads',
  workflows: 'workflows',
  'commerce-ingestion': 'commerce',
  'commerce-sync': 'sync',
  customers: 'customers',
  'workflow-temporal': 'temporal',
  assistant: 'assistant',
};
