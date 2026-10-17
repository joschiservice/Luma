/**
 * Inline script for the document head that turns off Zod's parser compilation before any
 * module loads. Zod compiles object parsers with `new Function`, deciding as each schema is
 * created; the page's Content Security Policy forbids eval, so every probe would report a
 * violation. Parsing without compilation behaves the same. Calling `z.config` from a module
 * is too late because bundled schema modules can run before it.
 */
export const zodConfigBootScript =
  '(globalThis.__zod_globalConfig??={}).jitless=true';
