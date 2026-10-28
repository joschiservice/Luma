import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  appLayers,
  connectorPackages,
  dependencies,
  domainPackages,
  layers,
} from './policy.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

const runtimePrefix = 'packages/application-runtime/src/';

const codeExtension = /\.(?:[cm]?[jt]sx?)$/;

const normalize = (file) =>
  file.replaceAll(path.sep, '/').replace(codeExtension, '.ts');

/** Workspace packages by name, with their directory and the source file of each export. */
const workspace = new Map(
  [
    'apps',
    'packages',
    'packages/apps',
    'packages/connectors',
    'packages/simulator',
  ]
    .flatMap((parent) =>
      readdirSync(path.join(root, parent), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${parent}/${entry.name}`),
    )
    .filter((dir) => existsSync(path.join(root, dir, 'package.json')))
    .map((dir) => {
      const manifest = JSON.parse(
        readFileSync(path.join(root, dir, 'package.json'), 'utf8'),
      );
      const sources = Object.entries(manifest.exports ?? {}).flatMap(
        ([subpath, conditions]) =>
          typeof conditions === 'object' && conditions['luma-source']
            ? [[subpath, conditions['luma-source']]]
            : [],
      );

      return [manifest.name, { dir, sources: new Map(sources) }];
    }),
);

/**
 * Resolves a `@luma/*` specifier to the file it loads. Packages that publish their sources
 * resolve through their `luma-source` exports, and an unexported subpath names the source file
 * it would reach, so its layer is still checked. Other packages resolve to their directory and
 * subpath, such as `packages/connectors/core/transport`.
 */
function packageTarget(specifier) {
  const [name, ...subpath] = specifier.slice('@luma/'.length).split('/');
  const target = workspace.get(`@luma/${name}`);
  if (!target) return `packages/${name}/${subpath.join('/')}`;
  const source = target.sources.get(
    subpath.length ? `./${subpath.join('/')}` : '.',
  );
  if (source) return normalize(path.posix.join(target.dir, source));
  if (target.sources.size)
    return `${target.dir}/src/${subpath.length ? `${subpath.join('/')}.ts` : 'index.ts'}`;

  return `${target.dir}/${subpath.join('/')}`;
}

function appInfo(file) {
  const match = /^packages\/apps\/([^/]+)\/src\/(.+)$/.exec(file);
  if (!match) return null;
  const [layer, ...rest] = match[2].split('/');

  return { app: match[1], layer, root: rest.length === 0 };
}

/** Returns why an import between files of workspace apps is not permitted, or null. */
function appViolation(from, source, target) {
  if (source.app !== target.app)
    return "Apps must not import another app's source.";
  if (source.root || source.layer === 'test-support') return null;
  const allowed = appLayers[source.layer];
  if (!allowed)
    return `Place app code in a ${Object.keys(appLayers).join('/')} layer or a root composition file.`;
  if (allowed.includes(target.layer)) return null;
  // Tests may also use test support and the app's composed entry points.
  if (
    /\.test\.ts$/.test(from) &&
    (target.root || target.layer === 'test-support')
  )
    return null;

  return 'Import violates the app layer direction.';
}

/**
 * Names the backend module and layer of a domain package source file, or null. The Temporal
 * package is one flat adapter: its root export is the module's composition entry point.
 */
function moduleInfo(file) {
  const match = /^packages\/([^/]+)\/src\/(.+)$/.exec(file);
  const name = match && domainPackages[match[1]];
  if (!name) return null;
  if (match[1] === 'workflow-temporal')
    return match[2] === 'index.ts'
      ? { name, layer: 'composition.ts', entry: true }
      : { name, layer: 'infrastructure', entry: false };
  const [layer, ...rest] = match[2].split('/');

  return { name, layer, entry: rest.length === 0 };
}

/**
 * Returns the reason an import crosses a forbidden ownership or layer boundary, or null when
 * permitted.
 */
export function violation(from, to) {
  const source = moduleInfo(from);
  const target = moduleInfo(to);
  const sourceApp = appInfo(from);
  const targetApp = appInfo(to);
  if (sourceApp && targetApp) return appViolation(from, sourceApp, targetApp);
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
        !from.startsWith(runtimePrefix))
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
    from.split('/')[1] !== to.split('/')[1]
  ) {
    return 'Apps must communicate through public API contracts, not source imports.';
  }
  if (!source && target) {
    if (
      !from.startsWith(runtimePrefix) &&
      ![
        'apps/api/src/index.ts',
        'apps/worker/src/index.ts',
        'apps/worker/src/bootstrap.ts',
        'apps/worker/src/sync.ts',
        'apps/worker/src/sync-bootstrap.ts',
        'apps/staff-api/src/index.ts',
        'apps/staff-api/scripts/provision.ts',
      ].includes(from) &&
      !/^apps\/(?:api|staff-api)\/src\/composition\/[^/]+\.ts$/.test(from) &&
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
    // Identity's mail delivery renders the shared email templates in the recipient's language.
    if (
      source.name === 'identity' &&
      source.layer === 'infrastructure' &&
      ['packages/email/', 'packages/i18n/locales'].includes(to)
    )
      return null;
    if (
      (source.layer === 'api' ||
        from.endsWith('/infrastructure/learning-validation.ts') ||
        from.endsWith('/infrastructure/measurement-validation.ts') ||
        from.endsWith('/infrastructure/shadow-validation.ts') ||
        from.endsWith('/infrastructure/diagnosis-validation.ts') ||
        (source.name === 'adaptive' &&
          (from.endsWith('/infrastructure/fields-validation.ts') ||
            from.endsWith('/infrastructure/views-validation.ts') ||
            from.endsWith('/infrastructure/collections-validation.ts') ||
            from.endsWith('/infrastructure/package-configuration.ts')))) &&
      (to === 'packages/api-contract/' ||
        (source.name === 'staff' && to === 'packages/api-contract/staff'))
    )
      return null;
    if (source.name === 'connectors') {
      if (to === 'packages/connectors/core/') return null;
      // Capability invocation carries an authority callback without importing provider transport.
      if (
        to === 'packages/connectors/core/dispatch' &&
        from.endsWith('/application/capabilities.ts')
      )
        return null;
      if (['infrastructure', 'composition.ts'].includes(source.layer)) {
        if (
          [
            'packages/connectors/core/transport',
            'packages/connectors/core/dispatch',
          ].includes(to)
        )
          return null;
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
      if (value.startsWith('.')) {
        to = normalize(
          path.posix.normalize(
            path.posix.join(path.posix.dirname(from), value),
          ),
        );
      } else if (value.startsWith('@luma/')) {
        to = packageTarget(value);
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
            'Use package exports or relative imports inside the backend.',
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
