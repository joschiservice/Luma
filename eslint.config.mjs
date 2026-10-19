import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import jsdoc from 'eslint-plugin-jsdoc';
import reactHooks from 'eslint-plugin-react-hooks';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import architecture from './tooling/architecture/eslint-plugin.mjs';
import ui from './tooling/style/eslint-plugin.mjs';

// `no-restricted-syntax` options replace each other per file, so every block that sets the rule
// starts with these shared restrictions.
const sharedRestrictedSyntax = [
  {
    selector:
      'Program > :not(ImportDeclaration):not(ExpressionStatement[directive]) ~ ImportDeclaration',
    message: 'Keep static imports together at the top of the file.',
  },
  {
    // The server's IdentityError became ServiceError and the web client's class became ApiError;
    // keep the ambiguous name from returning on either side.
    selector: "Identifier[name='IdentityError']:not(ImportSpecifier > .local)",
    message:
      'IdentityError no longer exists. Server code throws ServiceError or its helpers (notFound, conflict, invalid, forbidden, unavailable) from @luma/platform; web code uses ApiError from apps/web/src/lib/api-error.ts.',
  },
  // The ServiceError helpers return the error; called as a statement, the check does nothing.
  // Only calls of the helpers imported from @luma/platform match; local throwing helpers may share a name.
  ...['notFound', 'conflict', 'invalid', 'forbidden', 'unavailable'].map(
    (name) => ({
      selector: `Program:has(ImportDeclaration[source.value='@luma/platform'] ImportSpecifier[imported.name='${name}'][local.name='${name}']) ExpressionStatement > CallExpression[callee.name='${name}']`,
      message: `${name}() returns the ServiceError without throwing it. Write \`throw ${name}(...)\`.`,
    }),
  ),
];

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/.luma/**',
      '**/storybook-static/**',
      '**/.output/**',
      '**/.tanstack/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/routeTree.gen.ts',
      '**/cdk.out/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,
  {
    rules: {
      // Type aliases retain implicit index signatures used by database row constraints.
      '@typescript-eslint/consistent-type-definitions': 'off',
    },
  },
  { languageOptions: { globals: globals.node } },
  {
    files: [
      '**/*.test.{ts,tsx,js,mjs}',
      '**/*.stories.{ts,tsx}',
      '**/*.fixture.{ts,tsx}',
      '**/test-support/**',
      '**/e2e/**',
    ],
    rules: { '@typescript-eslint/no-empty-function': 'off' },
  },
  {
    files: [
      'apps/web/**/*.{ts,tsx}',
      'packages/ui/**/*.{ts,tsx}',
      'apps/simulator-web/**/*.{ts,tsx}',
      'apps/staff/**/*.{ts,tsx}',
    ],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ['apps/**/*.{ts,tsx,js,mjs}', 'packages/**/*.{ts,tsx,js,mjs}'],
    plugins: { architecture },
    rules: { 'architecture/boundaries': 'error' },
  },
  {
    files: [
      'apps/web/src/**/*.{ts,tsx}',
      'apps/staff/src/**/*.{ts,tsx}',
      'packages/apps/*/src/web/**/*.{ts,tsx}',
    ],
    plugins: { ui },
    rules: { 'ui/primitive-appearance': 'error' },
  },
  {
    // Server rendering shares module scope across requests in different languages.
    files: ['apps/web/src/**/*.{ts,tsx}', 'packages/**/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.*', '**/*.stories.*', '**/storybook-*'],
    plugins: { ui },
    rules: { 'ui/module-scope-message': 'error' },
  },
  prettier,
  {
    files: ['**/*.{ts,tsx,js,mjs}'],
    plugins: {
      '@stylistic': stylistic,
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'no-restricted-syntax': ['error', ...sharedRestrictedSyntax],
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'import', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
        {
          blankLine: 'always',
          prev: '*',
          next: ['function', 'class', 'interface', 'type', 'export'],
        },
        {
          blankLine: 'always',
          prev: ['function', 'class', 'interface', 'type'],
          next: '*',
        },
        { blankLine: 'always', prev: '*', next: 'return' },
      ],
    },
  },
  {
    // Authorization asks for permissions. Role names are identity's concern (LUMA-135).
    files: [
      'apps/**/src/**/*.{ts,tsx}',
      'packages/**/src/**/*.{ts,tsx}',
      'tooling/**/*.mjs',
    ],
    ignores: [
      'packages/identity/**',
      'apps/web/src/kit/identity/permissions.tsx',
      '**/*.test.*',
      '**/*.stories.*',
      '**/*.fixture.*',
      '**/test-support/**',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...sharedRestrictedSyntax,
        {
          selector: "Identifier[name='requireRole']",
          message:
            'Check a permission with requirePermission or hasPermission.',
        },
        {
          selector:
            'BinaryExpression[operator=/^[!=]==?$/]:has(Literal[value=/^(owner|admin|member)$/]):has(MemberExpression[property.name=/^(role|key)$/])',
          message:
            'Do not compare roles; check a permission (or use isOwnerRole for ownership).',
        },
        {
          selector:
            "CallExpression[callee.property.name='includes']:has(ArrayExpression > Literal[value=/^(owner|admin)$/])",
          message: 'Do not check role lists; check a permission instead.',
        },
      ],
    },
  },
  {
    files: [
      'apps/**/src/**/*.{ts,tsx}',
      'packages/**/src/**/*.{ts,tsx}',
      'tooling/**/*.mjs',
    ],
    ignores: [
      '**/*.test.*',
      '**/*.stories.*',
      '**/test-support/**',
      '**/fixtures/**',
      '**/routes/**',
    ],
    plugins: { jsdoc },
    settings: { jsdoc: { mode: 'typescript' } },
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          enableFixer: false,
          require: {
            FunctionDeclaration: true,
            ArrowFunctionExpression: true,
            FunctionExpression: true,
          },
        },
      ],
      'jsdoc/require-description': 'error',
    },
  },
);
