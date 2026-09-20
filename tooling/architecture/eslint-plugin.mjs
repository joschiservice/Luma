import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dependencies, layers } from './policy.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const modulePrefix = 'apps/api/src/modules/';
const codeExtension = /\.(?:[cm]?[jt]sx?)$/;
const normalize = (file) =>
  file.replaceAll(path.sep, '/').replace(codeExtension, '.ts');
const apiImports = JSON.parse(
  readFileSync(new URL('../../apps/api/package.json', import.meta.url), 'utf8'),
).imports;

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

export function violation(from, to) {
  const source = moduleInfo(from);
  const target = moduleInfo(to);
  if (from.startsWith('packages/') && to.startsWith('apps/')) {
    return 'Packages must not import apps.';
  }
  if (
    from.startsWith('apps/') &&
    to.startsWith('apps/') &&
    from.split('/')[1] !== to.split('/')[1]
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
        'apps/api/src/execution.integration.test.ts',
        'apps/api/src/diagnosis-reread.test.ts',
        'apps/api/src/workflow-runtime.test.ts',
        'apps/api/src/connections.integration.test.ts',
        'apps/api/src/shopify-oauth.integration.test.ts',
        'apps/api/src/connections.test.ts',
        'apps/api/src/test-support/detection-fixtures.ts',
        'apps/api/src/test-support/safety-fixtures.ts',
        'apps/api/src/index.ts',
      ].includes(from)
    ) {
      return 'Only the API composition root may wire backend modules.';
    }
    if (
      !target.entry ||
      !['index.ts', 'composition.ts'].includes(target.layer)
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
    if (source.layer === 'api' && to === 'packages/api-contract/') return null;
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
  if (!target.entry || target.layer !== 'index.ts')
    return 'Cross-module imports must use index.ts.';
  if (!dependencies[source.name].includes(target.name))
    return 'Import violates the module dependency map.';
  if (source.layer === 'domain' && target.name !== 'platform') {
    return 'Domain code may only import its own domain and platform primitives.';
  }
  return null;
}

const rule = {
  meta: { type: 'problem', schema: [], messages: { boundary: '{{reason}}' } },
  create(context) {
    const from = normalize(path.relative(root, context.filename));
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
      if (value.startsWith('#') && from.startsWith('apps/api/')) {
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
            path.posix.join(path.posix.dirname(from), value),
          ),
        );
      } else if (value.startsWith('@luma/')) {
        const [name, ...subpath] = value.slice(6).split('/');
        to = `packages/${name}/${subpath.join('/')}`;
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
              !['index.ts', 'composition.ts'].includes(source.layer)))
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
