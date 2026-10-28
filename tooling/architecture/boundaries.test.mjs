import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';

import plugin, { violation } from './eslint-plugin.mjs';
import { dependencies, domainPackages } from './policy.mjs';

RuleTester.describe = describe;

RuleTester.it = it;

const filename = (file) =>
  fileURLToPath(new URL(`../../${file}`, import.meta.url));

const packageOf = Object.fromEntries(
  Object.entries(domainPackages).map(([directory, module]) => [
    module,
    directory,
  ]),
);

const moduleFile = (module, layer = 'application/service.ts') =>
  filename(`packages/${packageOf[module]}/src/${layer}`);

const runtimeFile = (file) =>
  filename(`packages/application-runtime/src/${file}`);

const sample = (file, code) => ({ filename: file, code });

const invalid = (file, code) => ({
  ...sample(file, code),
  errors: [{ messageId: 'boundary' }],
});

new RuleTester({ languageOptions: { parser: tseslint.parser } }).run(
  'boundaries',
  plugin.rules.boundaries,
  {
    valid: [
      sample(
        moduleFile('connectors', 'infrastructure/shopify/adapter.ts'),
        "import { createClient } from '@luma/connector-shopify';",
      ),
      sample(
        moduleFile('connectors', 'infrastructure/jtl/adapter.ts'),
        "import { order } from '@luma/connector-jtl/schemas';",
      ),
      sample(
        moduleFile('connectors', 'domain/capabilities.ts'),
        "export { ConnectorError } from '@luma/connector-core';",
      ),
      sample(
        filename('packages/connectors/shopify/src/client.ts'),
        "import { ConnectorError } from '@luma/connector-core';",
      ),
      sample(
        moduleFile('connectors', 'infrastructure/installations/runtime.ts'),
        "import type { InstallationService } from '../../application/installations.js';",
      ),
      sample(
        runtimeFile('composition/services.ts'),
        "import { createCases } from '@luma/exceptions/composition';",
      ),
      sample(
        runtimeFile('composition/features/procurement.ts'),
        "import { procurementRoutes } from '@luma/procurement/http';",
      ),
      ...[
        'resolution-learning.test.ts',
        'connections.test.ts',
        'connections.integration.test.ts',
        'shopify-oauth.integration.test.ts',
        'commerce.integration.test.ts',
        'diagnosis-reread.test.ts',
        'workflow-runtime.test.ts',
      ].map((name) =>
        sample(
          runtimeFile(name),
          "import { createInstalledConnections } from '@luma/connections/composition';",
        ),
      ),
      sample(
        runtimeFile('exceptions.integration.test.ts'),
        "import { createExceptions } from '@luma/exceptions/composition';",
      ),
      sample(
        runtimeFile('test-support/detection-fixtures.ts'),
        "import { createCapabilityRuntime } from '@luma/connections/adapters';",
      ),
      sample(
        runtimeFile('app.test.ts'),
        "import { createObservability } from '@luma/platform/composition';",
      ),
      // Process entry points wire the runtime's services.
      ...[
        'apps/api/src/index.ts',
        'apps/api/src/composition/bootstrap.ts',
        'apps/worker/src/sync.ts',
        'apps/staff-api/src/composition/http-app.ts',
      ].map((file) =>
        sample(
          filename(file),
          "import { createIdentity } from '@luma/identity/composition';",
        ),
      ),
      sample(
        filename('apps/worker/src/index.ts'),
        "import { createWorkflowRuntime } from '@luma/application-runtime/worker';",
      ),
      sample(
        moduleFile('connectors', 'api/routes.ts'),
        "import { apiContract } from '@luma/api-contract';",
      ),
      sample(
        moduleFile('orders', 'infrastructure/repository.ts'),
        "import { join } from 'node:path';",
      ),
      sample(
        moduleFile('orders', 'composition.ts'),
        "const driver = require('pg');",
      ),
      sample(
        moduleFile('orders'),
        "import type { Order } from '../domain/order.js';",
      ),
      sample(
        moduleFile('execution'),
        "import type { Policy } from '@luma/policies';",
      ),
      sample(
        moduleFile('execution'),
        "import type { Policy } from '../../../policies/src/index.js';",
      ),
      sample(
        moduleFile('orders', 'domain/order.ts'),
        "import type { TenantId } from '@luma/platform';",
      ),
      sample(
        moduleFile('orders', 'infrastructure/repository.ts'),
        "import { pgTable } from 'drizzle-orm/pg-core';",
      ),
      sample(
        moduleFile('orders', 'composition.ts'),
        "import { repository } from './infrastructure/repository.js';",
      ),
      sample(
        runtimeFile('app.ts'),
        "import { createOrders } from '@luma/orders/composition';",
      ),
      sample(
        filename('apps/web/src/home.tsx'),
        "import { Button } from '@luma/ui/components/primitives/button';",
      ),
      sample(
        moduleFile('orders', 'domain/order.test.ts'),
        "import { expect } from 'vitest';",
      ),
    ],
    invalid: [
      invalid(
        runtimeFile('resolution-learning.test.ts'),
        "import { createLearningService } from '@luma/workflows/application/learning';",
      ),
      invalid(
        moduleFile('connectors', 'application/installations.ts'),
        "import { createClient } from '@luma/connector-shopify';",
      ),
      invalid(
        moduleFile('connectors', 'domain/capabilities.ts'),
        "import { parse } from '@luma/connector-core/transport';",
      ),
      invalid(
        moduleFile('orders', 'infrastructure/projections.ts'),
        "import { createClient } from '@luma/connector-jtl';",
      ),
      invalid(
        moduleFile('connectors', 'infrastructure/shopify/adapter.ts'),
        "import { createClient } from '@luma/connector-shopify/src/client';",
      ),
      invalid(
        filename('packages/connectors/shopify/src/client.ts'),
        "import type { TenantContext } from '@luma/identity';",
      ),
      invalid(
        filename('packages/connectors/jtl/src/client.ts'),
        "import { buildApp } from '../../../../apps/api/src/index.js';",
      ),
      invalid(
        runtimeFile('composition/services.ts'),
        "import { app } from '../../../../apps/web/src/router.js';",
      ),
      invalid(
        moduleFile('connectors', 'application/installations.ts'),
        "import { createSecretCipher } from '../infrastructure/installations/secret-cipher.js';",
      ),
      invalid(
        moduleFile('execution', 'infrastructure/adapter.ts'),
        "import { createSecretCipher } from '@luma/connections/infrastructure/installations/secret-cipher';",
      ),
      invalid(
        runtimeFile('composition/services.ts'),
        "import { createCaseReader } from '@luma/exceptions/infrastructure/cases';",
      ),
      invalid(
        moduleFile('exceptions'),
        "import { createDetectionServices } from '../../../application-runtime/src/composition/services.js';",
      ),
      ...[
        'connections.test.ts',
        'connections.integration.test.ts',
        'shopify-oauth.integration.test.ts',
        'commerce.integration.test.ts',
        'diagnosis-reread.test.ts',
        'workflow-runtime.test.ts',
      ].map((name) =>
        invalid(
          runtimeFile(name),
          "import { createSecretCipher } from '@luma/connections/infrastructure/installations/secret-cipher';",
        ),
      ),
      invalid(
        runtimeFile('exceptions.integration.test.ts'),
        "import { createDetectionRepository } from '@luma/exceptions/infrastructure/repository';",
      ),
      invalid(
        runtimeFile('app.ts'),
        "import { createJtlConnector } from '@luma/connections/infrastructure/jtl/adapter';",
      ),
      invalid(
        runtimeFile('app.test.ts'),
        "import { adapter } from '../../platform/src/infrastructure/adapter.js';",
      ),
      ...[
        'domain/model.ts',
        'application/query.ts',
        'index.ts',
        'infrastructure/repository.ts',
        'composition.ts',
      ].map((layer) =>
        invalid(
          moduleFile('connectors', layer),
          "import { apiContract } from '@luma/api-contract';",
        ),
      ),
      invalid(
        moduleFile('connectors', 'api/routes.ts'),
        "import { createApiClient } from '@luma/api-contract/client';",
      ),
      ...['infrastructure/repository.ts', 'composition.ts'].flatMap((layer) =>
        ['node:module', 'module'].flatMap((specifier) =>
          [
            `import { createRequire } from '${specifier}'; const load = createRequire(import.meta.url); load('@luma/inventory');`,
            `import { createRequire as makeLoader } from '${specifier}'; const load = makeLoader(import.meta.url); load('@luma/inventory');`,
            `import * as nodeModule from '${specifier}'; const load = nodeModule.createRequire(import.meta.url); load('@luma/inventory');`,
            `import nodeModule from '${specifier}'; const load = nodeModule.createRequire(import.meta.url); load('@luma/inventory');`,
            `const { createRequire } = await import('${specifier}'); const load = createRequire(import.meta.url); load('@luma/inventory');`,
            `const { createRequire } = require('${specifier}'); const load = createRequire(import.meta.url); load('@luma/inventory');`,
            `export { createRequire as makeLoader } from '${specifier}';`,
            `export * from '${specifier}';`,
          ].map((code) => invalid(moduleFile('orders', layer), code)),
        ),
      ),
      invalid(moduleFile('orders'), "import { stock } from '@luma/inventory';"),
      invalid(
        moduleFile('orders'),
        "import { stock } from '../../../inventory/src/index.js';",
      ),
      invalid(
        moduleFile('execution'),
        "import { policy } from '@luma/policies/domain/policy';",
      ),
      invalid(
        moduleFile('orders'),
        "export * from '../infrastructure/repository.js';",
      ),
      invalid(
        moduleFile('orders', 'domain/order.ts'),
        "import type { User } from '@luma/identity';",
      ),
      invalid(
        moduleFile('orders', 'domain/order.ts'),
        "import Fastify from 'fastify';",
      ),
      invalid(moduleFile('orders'), "import type { SQL } from 'drizzle-orm';"),
      invalid(
        moduleFile('orders', 'index.ts'),
        "export * from './infrastructure/repository.js';",
      ),
      invalid(
        moduleFile('orders', 'api/routes.ts'),
        "import { repository } from '../infrastructure/repository.js';",
      ),
      invalid(
        moduleFile('orders'),
        "const policy = import('@luma/execution');",
      ),
      invalid(
        moduleFile('orders'),
        "const policy = require('@luma/execution');",
      ),
      invalid(
        moduleFile('orders'),
        "type Policy = import('@luma/execution').Policy;",
      ),
      invalid(moduleFile('orders'), 'const adapter = import(name);'),
      invalid(moduleFile('orders'), "import x from '#internal/orders';"),
      ...['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].map(
        (extension) =>
          invalid(
            moduleFile('identity'),
            `import type { TenantContext } from '#modules/identity/domain/context.${extension}';`,
          ),
      ),
      invalid(moduleFile('orders'), "import { config } from '@luma/config';"),
      invalid(
        moduleFile('orders'),
        "import { buildApp } from '@luma/application-runtime';",
      ),
      invalid(moduleFile('orders'), "import x from '@luma/unknown';"),
      invalid(moduleFile('orders', 'helpers.ts'), 'export {};'),
      invalid(
        filename('packages/config/src/index.ts'),
        "import { app } from '../../../apps/api/src/index.js';",
      ),
      invalid(
        filename('apps/web/src/home.tsx'),
        "import { orders } from '../../../packages/orders/src/index.js';",
      ),
      invalid(
        runtimeFile('app.ts'),
        "import { repo } from '@luma/orders/infrastructure/repo';",
      ),
      invalid(
        filename('apps/api/src/helper.ts'),
        "import { orders } from '@luma/orders';",
      ),
    ],
  },
);

test('the declared module graph is acyclic and references registered modules', () => {
  function visit(name, ancestors = []) {
    assert.ok(
      !ancestors.includes(name),
      `Cycle: ${[...ancestors, name].join(' -> ')}`,
    );
    assert.ok(Object.hasOwn(dependencies, name), `Unknown module: ${name}`);
    for (const provider of dependencies[name])
      visit(provider, [...ancestors, name]);
  }

  for (const name of Object.keys(dependencies)) visit(name);
});

test("ADR-001's module table matches the enforced dependency map", () => {
  const adr = readFileSync(
    filename('docs/architecture/001-module-boundaries.md'),
    'utf8',
  );
  const table = adr
    .split('## Module map and allowed imports')[1]
    .split('\n## ')[0]
    .split('\n')
    .filter((line) => line.startsWith('| '))
    .slice(2) // Header and separator rows.
    .map((line) => line.split('|').map((cell) => cell.trim()));
  const documented = Object.fromEntries(
    table.map(([, name, , providers]) => [
      name,
      providers === 'none' ? [] : providers.split(/,\s*/).sort(),
    ]),
  );
  const enforced = Object.fromEntries(
    Object.entries(dependencies).map(([name, providers]) => [
      name,
      [...providers].sort(),
    ]),
  );

  assert.deepEqual(documented, enforced);
});

test('simulator packages cannot cross provider or connector boundaries', () => {
  assert.equal(
    violation(
      'packages/simulator/jtl/src/index.ts',
      'packages/simulator/core/',
    ),
    null,
  );
  assert.match(
    violation(
      'packages/simulator/jtl/src/index.ts',
      'packages/simulator/shopify/',
    ),
    /only on simulator core/,
  );
  assert.match(
    violation(
      'packages/simulator/core/src/index.ts',
      'packages/simulator/jtl/',
    ),
    /only on simulator core/,
  );
  assert.match(
    violation(
      'packages/connectors/jtl/src/client.ts',
      'packages/simulator/jtl/',
    ),
    /independent of simulators/,
  );
});

test('extracted domains retain layer boundaries and narrow public interfaces', () => {
  assert.equal(
    violation(
      'packages/identity/src/infrastructure/mail-dispatch.ts',
      'packages/email/',
    ),
    null,
  );
  assert.match(
    violation('packages/identity/src/domain/password.ts', 'packages/email/'),
    /registered module interfaces/,
  );
  assert.match(
    violation(
      'packages/identity/src/infrastructure/password-mail.ts',
      'packages/i18n/messages',
    ),
    /registered module interfaces/,
  );
  assert.match(
    violation(
      'packages/identity/src/infrastructure/password-mail.ts',
      'packages/i18n/runtime',
    ),
    /registered module interfaces/,
  );
  assert.equal(
    violation(
      'packages/execution/src/application/execution.ts',
      'packages/policies/src/index.ts',
    ),
    null,
  );
  assert.match(
    violation(
      'packages/execution/src/application/execution.ts',
      'packages/policies/src/infrastructure/repository.ts',
    ),
    /index.ts/,
  );
  assert.match(
    violation(
      'packages/resolution/src/composition.ts',
      'packages/resolution/src/api/learning.ts',
    ),
    /layer direction/,
  );
  assert.match(
    violation(
      'packages/resolution/src/application/runtime.ts',
      'packages/application-runtime/src/app.ts',
    ),
    /registered module interfaces/,
  );
  assert.equal(
    violation(
      'packages/commerce-ingestion/src/index.ts',
      'packages/orders/src/index.ts',
    ),
    null,
  );
  assert.match(
    violation(
      'packages/workflow-temporal/src/runtime.ts',
      'packages/execution/src/composition.ts',
    ),
    /index.ts/,
  );
});

test('domain package exports are explicit and their workspace dependencies are acyclic', () => {
  const manifests = new Map(
    Object.keys(domainPackages)
      .concat('application-runtime')
      .map((name) => {
        const manifest = JSON.parse(
          readFileSync(filename(`packages/${name}/package.json`), 'utf8'),
        );
        assert.ok(
          Object.keys(manifest.exports).every((key) => !key.includes('*')),
          `${name} exposes private subpaths`,
        );

        return [manifest.name, manifest];
      }),
  );

  function visit(name, ancestors = []) {
    assert.ok(
      !ancestors.includes(name),
      `Package cycle: ${[...ancestors, name].join(' -> ')}`,
    );
    for (const dependency of Object.keys(
      manifests.get(name).dependencies ?? {},
    )) {
      if (manifests.has(dependency)) visit(dependency, [...ancestors, name]);
    }
  }

  for (const name of manifests.keys()) visit(name);
});

test('Workflows own definitions and runs without depending on Resolution or Exceptions', () => {
  assert.equal(domainPackages.workflows, 'workflows');
  assert.equal(domainPackages.resolution, 'resolution');
  assert.ok(dependencies.resolution.includes('workflows'));
  assert.ok(!dependencies.workflows.includes('resolution'));
  assert.ok(!dependencies.workflows.includes('exceptions'));
  assert.match(
    violation(
      'packages/workflows/src/application/catalog.ts',
      'packages/resolution/src/index.ts',
    ),
    /dependency map/,
  );
  assert.equal(
    violation(
      'packages/resolution/src/composition.ts',
      'packages/workflows/src/composition.ts',
    ),
    null,
  );
  assert.match(
    violation(
      'packages/resolution/src/application/runtime.ts',
      'packages/workflows/src/composition.ts',
    ),
    /index.ts/,
  );
});
