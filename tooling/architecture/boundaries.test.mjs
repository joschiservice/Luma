import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

const moduleFile = (module, layer = 'application/service.ts') =>
  filename(`apps/api/src/modules/${module}/${layer}`);

const sample = (file, code) => ({ filename: file, code });

const invalid = (file, code) => ({
  ...sample(file, code),
  errors: [{ messageId: 'boundary' }],
});

// Run every relative-import boundary case through the native package imports too.
function withPackageImport(entry) {
  const sourceRoot = filename('apps/api/src/');
  if (!entry.filename.startsWith(sourceRoot)) return [entry];
  const code = entry.code.replace(
    /(['"])(\.[^'"]+\.js)\1/g,
    (match, quote, specifier) => {
      const target = path.resolve(path.dirname(entry.filename), specifier);
      if (!target.startsWith(sourceRoot)) return match;
      const relative = path
        .relative(sourceRoot, target)
        .replaceAll(path.sep, '/')
        .slice(0, -3);

      return `${quote}#${relative}${quote}`;
    },
  );

  return code === entry.code ? [entry] : [entry, { ...entry, code }];
}

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
        "import type { InstallationService } from '#modules/connectors/application/installations';",
      ),
      sample(
        filename('apps/api/src/composition/services.ts'),
        "import { createCases } from '#modules/exceptions/composition';",
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
          filename(`apps/api/src/${name}`),
          "import { createInstalledConnections } from './modules/connectors/composition.js';",
        ),
      ),
      sample(
        filename('apps/api/src/exceptions.integration.test.ts'),
        "import { createExceptions } from './modules/exceptions/composition.js';",
      ),
      sample(
        filename('apps/api/src/test-support/detection-fixtures.ts'),
        "import { createInstalledRuntime } from '../modules/connectors/composition.js';",
      ),
      sample(
        filename('apps/api/src/app.test.ts'),
        "import { createObservability } from './modules/platform/composition.js';",
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
        "import type { Policy } from '../../policies/index.js';",
      ),
      sample(
        moduleFile('orders', 'domain/order.ts'),
        "import type { TenantId } from '../../platform/index.js';",
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
        filename('apps/api/src/app.ts'),
        "import { createOrders } from './modules/orders/composition.js';",
      ),
      sample(
        filename('apps/web/src/home.tsx'),
        "import { Button } from '@luma/ui/button';",
      ),
      sample(
        moduleFile('orders', 'domain/order.test.ts'),
        "import { expect } from 'vitest';",
      ),
    ].flatMap(withPackageImport),
    invalid: [
      invalid(
        filename('apps/api/src/resolution-learning.test.ts'),
        "import { createLearningService } from '#modules/workflows/application/learning';",
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
        "import type { TenantContext } from '#modules/identity/index';",
      ),
      invalid(
        filename('packages/connectors/jtl/src/client.ts'),
        "import { buildApp } from '../../../../apps/api/src/app.js';",
      ),
      invalid(
        moduleFile('connectors', 'application/installations.ts'),
        "import { createSecretCipher } from '#modules/connectors/infrastructure/installations/secret-cipher';",
      ),
      invalid(
        moduleFile('execution', 'infrastructure/adapter.ts'),
        "import { createSecretCipher } from '#modules/connectors/infrastructure/installations/secret-cipher';",
      ),
      invalid(
        filename('apps/api/src/composition/services.ts'),
        "import { createCaseReader } from '#modules/exceptions/infrastructure/cases';",
      ),
      invalid(
        moduleFile('exceptions'),
        "import { createDetectionServices } from '../../../composition/services.js';",
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
          filename(`apps/api/src/${name}`),
          "import { createSecretCipher } from './modules/connectors/infrastructure/installations/secret-cipher.js';",
        ),
      ),
      invalid(
        filename('apps/api/src/exceptions.integration.test.ts'),
        "import { createDetectionRepository } from './modules/exceptions/infrastructure/repository.js';",
      ),
      invalid(
        filename('apps/api/src/app.ts'),
        "import { createJtlConnector } from './modules/connectors/infrastructure/jtl/adapter.js';",
      ),
      invalid(
        filename('apps/api/src/app.test.ts'),
        "import { adapter } from './modules/platform/infrastructure/adapter.js';",
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
            `import { createRequire } from '${specifier}'; const load = createRequire(import.meta.url); load('../../inventory/index.js');`,
            `import { createRequire as makeLoader } from '${specifier}'; const load = makeLoader(import.meta.url); load('../../inventory/index.js');`,
            `import * as nodeModule from '${specifier}'; const load = nodeModule.createRequire(import.meta.url); load('../../inventory/index.js');`,
            `import nodeModule from '${specifier}'; const load = nodeModule.createRequire(import.meta.url); load('../../inventory/index.js');`,
            `const { createRequire } = await import('${specifier}'); const load = createRequire(import.meta.url); load('../../inventory/index.js');`,
            `const { createRequire } = require('${specifier}'); const load = createRequire(import.meta.url); load('../../inventory/index.js');`,
            `export { createRequire as makeLoader } from '${specifier}';`,
            `export * from '${specifier}';`,
          ].map((code) => invalid(moduleFile('orders', layer), code)),
        ),
      ),
      invalid(
        moduleFile('orders'),
        "import { stock } from '../../inventory/index.js';",
      ),
      invalid(
        moduleFile('execution'),
        "import { policy } from '../../policies/domain/policy.js';",
      ),
      invalid(
        moduleFile('orders'),
        "export * from '../infrastructure/repository.js';",
      ),
      invalid(
        moduleFile('orders', 'domain/order.ts'),
        "import type { User } from '../../identity/index.js';",
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
        "const policy = import('../../policies/index.js');",
      ),
      invalid(
        moduleFile('orders'),
        "const policy = require('../../policies/index.js');",
      ),
      invalid(
        moduleFile('orders'),
        "type Policy = import('../../policies/index.js').Policy;",
      ),
      invalid(moduleFile('orders'), 'const adapter = import(name);'),
      invalid(moduleFile('orders'), "import x from '#internal/orders';"),
      ...['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].flatMap(
        (extension) => [
          invalid(
            moduleFile('identity'),
            `import type { TenantContext } from '#modules/identity/domain/context.${extension}';`,
          ),
          invalid(
            filename('apps/api/src/app.test.ts'),
            `import { detectionFixtures } from '#test-support/detection-fixtures.${extension}';`,
          ),
        ],
      ),
      invalid(
        moduleFile('orders'),
        "import x from '#modules/orders/../inventory/index';",
      ),
      invalid(
        moduleFile('orders'),
        "import x from '#modules/orders/%2e%2e/inventory/index';",
      ),
      invalid(moduleFile('orders'), "import x from '#modules/orders//index';"),
      invalid(
        moduleFile('orders'),
        "import x from '#test-support/detection-fixtures';",
      ),
      invalid(moduleFile('orders'), "import x from '#app';"),
      invalid(moduleFile('orders'), "import { config } from '@luma/config';"),
      invalid(moduleFile('orders'), "import { app } from '../../../app.js';"),
      invalid(moduleFile('orders'), "import x from '../../unknown/index.js';"),
      invalid(moduleFile('unknown'), 'export {};'),
      invalid(moduleFile('orders', 'helpers.ts'), 'export {};'),
      invalid(
        filename('packages/config/src/index.ts'),
        "import { app } from '../../../apps/api/src/app.js';",
      ),
      invalid(
        filename('apps/web/src/home.tsx'),
        "import { orders } from '../../api/src/modules/orders/index.js';",
      ),
      invalid(
        filename('apps/api/src/app.ts'),
        "import { repo } from './modules/orders/infrastructure/repo.js';",
      ),
      invalid(
        filename('apps/api/src/helper.ts'),
        "import { orders } from './modules/orders/index.js';",
      ),
    ].flatMap(withPackageImport),
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
