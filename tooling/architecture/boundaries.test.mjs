import assert from 'node:assert/strict';
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

new RuleTester({ languageOptions: { parser: tseslint.parser } }).run(
  'boundaries',
  plugin.rules.boundaries,
  {
    valid: [
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
    ],
    invalid: [
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
