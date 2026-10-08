import { existsSync } from 'node:fs';
import path from 'node:path';

import { compileCatalog } from './compile-catalog.mjs';
import {
  compilerOptions,
  productionCompilerOptions,
} from './compiler-options.mjs';

const messages = path.join(path.dirname(compilerOptions.project), 'messages');
const runtime = path.join(compilerOptions.outdir, 'runtime.js');
const shared = `${compilerOptions.outdir}${path.sep}`;
const production = `${productionCompilerOptions.outdir}${path.sep}`;
// The client and server environments of one build share a single compile.
let productionCatalog;

/**
 * Keeps the compiled message catalog current for Vite.
 *
 * Production builds compile the per-message runtime and redirect every import of the shared
 * runtime to it, including the formatting helpers' relative imports, so the bundle has a single
 * runtime instance and route chunks carry only their own messages. Dev servers reuse the shared
 * runtime the package build produced, compiling only when it is missing, and recompile when a
 * message file changes; many dev servers (such as parallel browser tests) can start at once
 * without rewriting it under each other.
 */
export function lumaI18n() {
  let command = 'serve';

  return {
    name: 'luma-i18n',
    enforce: 'pre',
    configResolved(config) {
      command = config.command;
    },
    async buildStart() {
      if (command === 'build')
        await (productionCatalog ??= compileCatalog({ production: true }));
      else if (!existsSync(runtime)) await compileCatalog();
    },
    async resolveId(source, importer, options) {
      if (command !== 'build') return null;
      if (!source.includes('paraglide') && !source.startsWith('@luma/i18n/'))
        return null;
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      if (!resolved?.id.startsWith(shared)) return null;

      return { ...resolved, id: production + resolved.id.slice(shared.length) };
    },
    configureServer(server) {
      server.watcher.add(messages);
      server.watcher.on('change', (file) => {
        if (!file.startsWith(messages) || !file.endsWith('.json')) return;
        compileCatalog().then(
          () => server.ws.send({ type: 'full-reload' }),
          (error) => server.config.logger.error(String(error)),
        );
      });
    },
  };
}
