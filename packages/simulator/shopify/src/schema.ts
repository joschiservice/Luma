import { readFileSync } from 'node:fs';

import { buildSchema, type GraphQLDirective } from 'graphql';

/**
 * Shopify Admin API 2026-07 types, fields and arguments that Luma uses, as generated from
 * Shopify's introspection for the adapter's contract tests. The file must stay identical to
 * the adapter fixture; the simulator contract test checks this.
 */
const schemaSource = readFileSync(
  new URL('../admin-2026-07.graphql', import.meta.url),
  'utf8',
);

export const schema = buildSchema(schemaSource);

/** Shopify's `@idempotent(key:)` directive on mutation fields. */
export const idempotent: GraphQLDirective = (() => {
  const directive = schema.getDirective('idempotent');
  if (!directive) throw new Error('Schema lacks the @idempotent directive');

  return directive;
})();
