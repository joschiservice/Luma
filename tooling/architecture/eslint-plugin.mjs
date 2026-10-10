import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  connectorPackages,
  dependencies,
  domainPackages,
  layers,
} from './policy.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

const modulePrefix = 'apps/api/src/modules/';

const codeExtension = /\.(?:[cm]?[jt]sx?)$/;

const normalize = (file) =>
  file.replaceAll(path.sep, '/').replace(codeExtension, '.ts');

const apiImports = {
  '#modules/*': { 'luma-source': './src/modules/*.ts' },
  '#test-support/*': { 'luma-source': './src/test-support/*.ts' },
  '#app': { 'luma-source': './src/app.ts' },
};

function canonical(file) {
  const match = /^packages\/([^/]+)\/src\/(.+)$/.exec(file);
  if (!match) return file;
  if (match[1] === 'application-runtime') return `apps/api/src/${match[2]}`;
  if (match[1] === 'workflow-temporal')
    return `${modulePrefix}temporal/${match[2] === 'index.ts' ? 'composition.ts' : `infrastructure/${match[2]}`}`;
  const module = domainPackages[match[1]];

  return module ? `${modulePrefix}${module}/${match[2]}` : file;
}

function apiImportTarget(specifier) {
  for (const [pattern, conditions] of Object.entries(apiImports)) {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : null;
    const subpath = prefix === null ? '' : specifier.slice(prefix.length);
    if (prefix === null ? specifier !== pattern : !specifier.startsWith(prefix))
      continue;
    if (
      prefix !== null &&
      (codeExtension.test(subpath) ||
        !/^[\w./-]+$/.test(subpath) ||
        subpath
          .split('/')
          .some((part) => ['', '.', '..', 'node_modules'].includes(part)))
    )
      return null;

    return normalize(
      path.posix.join(
        'apps/api',
        conditions['luma-source'].replace('*', subpath),
      ),
    );
  }

  return null;
}

function moduleInfo(file) {
  if (!file.startsWith(modulePrefix)) return null;
  const [name, layer, ...rest] = file.slice(modulePrefix.length).split('/');

  return { name, layer, entry: rest.length === 0 };
}

/**
 * Returns the reason an import crosses a forbidden ownership or layer boundary, or null when
 * permitted.
 */
export function violation(from, to) {
  from = canonical(from);
  to = canonical(to);
  const source = moduleInfo(from);
  const target = moduleInfo(to);
  if (
    from.startsWith('packages/app-host/') &&
    (to.startsWith('packages/apps/') ||
      (to.startsWith('packages/app-') && !to.startsWith('packages/app-host/')))
  )
    return 'The app host must remain independent of app implementations.';
  const extension =
    from.startsWith('packages/apps/') ||
    from.startsWith('packages/app-host/') ||
    from.startsWith('packages/app-catalog/');
  if (extension && target) {
    if (
      target.entry &&
      ['index.ts', 'composition.ts', 'adapters.ts', 'http.ts'].includes(
        target.layer,
      )
    )
      return null;

    return 'Apps must use public host package entry points.';
  }
  if (to.startsWith('packages/app-') || to.startsWith('packages/apps/')) {
    if (
      source ||
      (from.startsWith('packages/') &&
        !from.startsWith('packages/app-') &&
        !from.startsWith('packages/apps/') &&
        !from.startsWith('apps/api/'))
    )
      return 'Core modules must not depend on app implementations.';
  }
  if (
    from.startsWith('packages/connectors/') &&
    to.startsWith('packages/simulator/')
  )
    return 'Connectors must remain independent of simulators.';
  if (from.startsWith('packages/simulator/')) {
    const provider = from.split('/')[2];
    if (
      to.startsWith('packages/simulator/') &&
      ![provider, 'core'].includes(to.split('/')[2])
    )
      return 'Simulator providers may depend only on simulator core.';
    if (
      to.startsWith('packages/') &&
      !to.startsWith('packages/simulator/') &&
      !to.startsWith('packages/connectors/')
    )
      return 'Simulator packages own provider state independently of application models.';
  }
  if (from.startsWith('packages/') && to.startsWith('apps/'))
    return 'Packages must not import apps.';
  if (
    from.startsWith('apps/') &&
    to.startsWith('apps/') &&
    from.split('/')[1] !== to.split('/')[1] &&
    !moduleInfo(to) &&
    to !== 'apps/api/src/app.ts'
  ) {
    return 'Apps must communicate through public API contracts, not source imports.';
  }
  // Synthetic observation fixtures are excluded from the production build.
  if (
    from === 'apps/api/src/test-support/detection-fixtures.ts' &&
    [
      'apps/api/src/modules/connectors/application/capabilities.ts',
      'apps/api/src/modules/connectors/infrastructure/jtl/adapter.ts',
      'apps/api/src/modules/connectors/infrastructure/shopify/adapter.ts',
    ].includes(to)
  )
    return null;
  if (!source && target) {
    if (
      ![
        'apps/api/src/app.ts',
        'apps/api/src/app.test.ts',
        'apps/api/src/exceptions.integration.test.ts',
        'apps/api/src/commerce.integration.test.ts',
        'apps/api/src/commerce-sync.integration.test.ts',
        'apps/api/src/orders.integration.test.ts',
        'apps/api/src/activity.integration.test.ts',
        'apps/api/src/execution.integration.test.ts',
        'apps/api/src/diagnosis-reread.test.ts',
        'apps/api/src/workflow-runtime.test.ts',
        'apps/api/src/resolution-learning.test.ts',
        'apps/api/src/connections.integration.test.ts',
        'apps/api/src/staff.integration.test.ts',
        'apps/api/src/membership-suspension.integration.test.ts',
        'apps/api/src/support-view.integration.test.ts',
        'apps/api/src/support-view.test.ts',
        'apps/api/src/shopify-oauth.integration.test.ts',
        'apps/api/src/connections.test.ts',
        'apps/api/src/installation-verifier.test.ts',
        'apps/api/src/apps.integration.test.ts',
        'apps/api/src/test-support/apps.ts',
        'apps/api/src/test-support/detection-fixtures.ts',
        'apps/api/src/test-support/safety-fixtures.ts',
        'apps/api/src/index.ts',
        'apps/worker/src/index.ts',
        'apps/worker/src/bootstrap.ts',
        'apps/worker/src/sync.ts',
        'apps/worker/src/sync-bootstrap.ts',
        'apps/staff-api/src/index.ts',
        'apps/staff-api/scripts/provision.ts',
      ].includes(from) &&
      !/^apps\/api\/src\/composition\/[^/]+\.ts$/.test(from) &&
      !/^apps\/staff-api\/src\/composition\/[^/]+\.ts$/.test(from) &&
      !from.startsWith('apps/api/e2e/')
    ) {
      return 'Only the API composition root may wire backend modules.';
    }
    if (
      !target.entry ||
      !['index.ts', 'composition.ts', 'http.ts', 'adapters.ts'].includes(
        target.layer,
      )
    ) {
      return 'The composition root must use module entry points.';
    }
  }
  if (!source) return null;
  if (
    !Object.hasOwn(dependencies, source.name) ||
    !Object.hasOwn(layers, source.layer)
  ) {
    return 'Use a registered module and domain/application/infrastructure/api layer.';
  }
  if (!target) {
    if (
      (source.layer === 'api' ||
        from.endsWith('/infrastructure/learning-validation.ts') ||
        from.endsWith('/infrastructure/measurement-validation.ts') ||
        from.endsWith('/infrastructure/shadow-validation.ts') ||
        from.endsWith('/infrastructure/diagnosis-validation.ts')) &&
      (to === 'packages/api-contract/' ||
        (source.name === 'staff' && to === 'packages/api-contract/staff'))
    )
      return null;
    if (source.name === 'connectors') {
      if (to === 'packages/connectors/core/') return null;
      if (['infrastructure', 'composition.ts'].includes(source.layer)) {
        if (to === 'packages/connectors/core/transport') return null;
        for (const [name, exports] of Object.entries(connectorPackages)) {
          if (
            exports.some(
              (entry) =>
                to === `packages/connectors/${name.slice(10)}/${entry}`,
            )
          )
            return null;
        }
      }
    }
    // No paths back into the bootstrap, web app, or shared workspace runtime code.
    if (to.startsWith('apps/') || to.startsWith('packages/')) {
      return 'Backend modules may share runtime code only through registered module interfaces.';
    }

    return null;
  }
  if (!Object.hasOwn(dependencies, target.name))
    return 'Unknown backend module.';
  if (source.name === target.name) {
    if (!layers[source.layer].includes(target.layer))
      return 'Import violates the module layer direction.';

    return null;
  }
  // Staff auth composes the reviewed federation adapter, never its private layers.
  if (
    source.name === 'staff' &&
    ['composition.ts', 'infrastructure'].includes(source.layer) &&
    target.name === 'federation' &&
    target.layer === 'composition.ts' &&
    target.entry
  )
    return null;
  if (
    source.layer === 'api' &&
    target.name === 'identity' &&
    target.layer === 'http.ts'
  )
    return null;
  // Resolution's former public entry points forward to the Workflow owner during migration.
  if (
    source.name === 'resolution' &&
    target.name === 'workflows' &&
    ['composition.ts', 'http.ts'].includes(source.layer) &&
    source.layer === target.layer
  )
    return null;
  if (!target.entry || target.layer !== 'index.ts')
    return 'Cross-module imports must use index.ts.';
  if (!dependencies[source.name].includes(target.name))
    return 'Import violates the module dependency map.';
  if (
    source.layer === 'domain' &&
    target.name !== 'platform' &&
    !(source.name === 'resolution' && target.name === 'workflows')
  ) {
    return 'Domain code may only import its own domain and platform primitives.';
  }

  return null;
}

const rule = {
  meta: { type: 'problem', schema: [], messages: { boundary: '{{reason}}' } },
  create(context) {
    const physicalFrom = normalize(path.relative(root, context.filename));
    const from = canonical(physicalFrom);
    const source = moduleInfo(from);

    function report(node, reason) {
      context.report({ node, messageId: 'boundary', data: { reason } });
    }

    function check(node, value) {
      if (typeof value !== 'string') {
        if (source)
          report(node, 'Module imports must use static string specifiers.');

        return;
      }
      // Reject the loader provider itself so aliases, namespace imports and
      // dynamically obtained createRequire functions cannot evade this rule.
      if (source && (value === 'node:module' || value === 'module')) {
        report(
          node,
          'Backend modules must not use alternate Node loaders; use standard imports or literal require calls.',
        );

        return;
      }
      let to;
      if (
        value.startsWith('#') &&
        (from.startsWith('apps/api/') ||
          from.startsWith('packages/connectors/'))
      ) {
        to = apiImportTarget(value);
        if (!to) {
          report(
            node,
            'Use a declared API package import with a canonical path.',
          );

          return;
        }
      } else if (value.startsWith('.')) {
        to = normalize(
          path.posix.normalize(
            path.posix.join(path.posix.dirname(physicalFrom), value),
          ),
        );
      } else if (value.startsWith('@luma/')) {
        const [name, ...subpath] = value.slice(6).split('/');
        to = domainPackages[name]
          ? `apps/api/src/modules/${domainPackages[name]}/${subpath.length ? subpath.join('/') + '.ts' : name === 'workflow-temporal' ? 'composition.ts' : 'index.ts'}`
          : name === 'application-runtime'
            ? 'apps/api/src/app.ts'
            : name.startsWith('simulator-')
              ? `packages/simulator/${name.slice(10)}/${subpath.join('/')}`
              : Object.hasOwn(connectorPackages, name)
                ? `packages/connectors/${name.slice(10)}/${subpath.join('/')}`
                : `packages/${name}/${subpath.join('/')}`;
      } else {
        // Only package imports with known source targets can be checked for ownership.
        if (
          source &&
          (value.startsWith('/') ||
            value.startsWith('#') ||
            value.startsWith('@/') ||
            value.startsWith('~/'))
        ) {
          report(
            node,
            'Use declared API package imports or relative imports inside the backend.',
          );
        } else if (
          source &&
          ['domain', 'application', 'index.ts'].includes(source.layer) &&
          !(value === 'vitest' && /\.test\.ts$/.test(from))
        ) {
          report(
            node,
            'Domain, application and public interfaces must be framework independent; inject an adapter.',
          );
        }

        return;
      }
      const reason = violation(from, to);
      if (reason) report(node, reason);
    }

    return {
      Program(node) {
        if (
          source &&
          (!Object.hasOwn(dependencies, source.name) ||
            !Object.hasOwn(layers, source.layer) ||
            (source.entry &&
              ![
                'index.ts',
                'composition.ts',
                'http.ts',
                'adapters.ts',
              ].includes(source.layer)))
        ) {
          report(
            node,
            'Use a registered module and domain/application/infrastructure/api layer.',
          );
        }
      },
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) => {
        if (node.source) check(node, node.source.value);
      },
      ExportAllDeclaration: (node) => check(node, node.source.value),
      ImportExpression: (node) => check(node, node.source.value),
      TSImportType: (node) =>
        check(node, node.argument?.value ?? node.argument?.literal?.value),
      TSExternalModuleReference: (node) => check(node, node.expression.value),
      CallExpression: (node) => {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require')
          check(node, node.arguments[0]?.value);
      },
    };
  },
};

export default { rules: { boundaries: rule } };
