import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import plugin from './eslint-plugin.mjs';
import { dependencies } from './policy.mjs';

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
      ...[
        'connections.test.ts',
        'connections.integration.test.ts',
        'shopify-oauth.integration.test.ts',
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
        "import { createJtlConnector } from '../modules/connectors/composition.js';",
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
      ...[
        'connections.test.ts',
        'connections.integration.test.ts',
        'shopify-oauth.integration.test.ts',
        'diagnosis-reread.test.ts',
        'workflow-runtime.test.ts',
      ].map((name) =>
        invalid(
          filename(`apps/api/src/${name}`),
          "import { createSecretCipher } from './modules/connectors/infrastructure/secret-cipher.js';",
        ),
      ),
      invalid(
        filename('apps/api/src/exceptions.integration.test.ts'),
        "import { createDetectionRepository } from './modules/exceptions/infrastructure/repository.js';",
      ),
      invalid(
        filename('apps/api/src/test-support/detection-fixtures.ts'),
        "import { createJtlConnector } from '../modules/connectors/infrastructure/jtl/adapter.js';",
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
