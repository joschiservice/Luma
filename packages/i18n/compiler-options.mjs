import { fileURLToPath } from 'node:url';

/**
 * Paraglide compiler options shared by the package build, dev servers and production builds.
 * The locale comes from the `luma_locale` cookie, then the browser or request language, then
 * English.
 *
 * The shared runtime has one module per locale: unbundled Vite dev servers request every module
 * a page imports, and one module per message meant thousands of requests per page.
 */
export const compilerOptions = {
  project: fileURLToPath(new URL('./project.inlang', import.meta.url)),
  outdir: fileURLToPath(new URL('./dist/paraglide', import.meta.url)),
  strategy: ['cookie', 'preferredLanguage', 'baseLocale'],
  cookieName: 'luma_locale',
  emitTsDeclarations: true,
  outputStructure: 'locale-modules',
};

/**
 * Production builds compile one module per message into their own directory, so each route
 * chunk carries only the messages it uses and a build never rewrites the runtime a running dev
 * server reads.
 */
export const productionCompilerOptions = {
  ...compilerOptions,
  outdir: fileURLToPath(
    new URL('./dist/paraglide-production', import.meta.url),
  ),
  emitTsDeclarations: false,
  outputStructure: 'message-modules',
};
