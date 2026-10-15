import { compileProject } from '@inlang/paraglide-js';

/**
 * Compiles runtime JavaScript and declarations from the same loaded project. Declarations
 * use small per-message modules: TypeScript repeatedly scans large locale modules when
 * resolving exported types, making declaration emission grow quadratically with the catalog.
 * JavaScript retains the requested layout, so dev servers still load only a few modules.
 */
export async function compileCatalogOutput(project, options) {
  const output = await compileProject({
    project,
    projectPath: options.project,
    compilerOptions: { ...options, emitTsDeclarations: false },
  });
  if (!options.emitTsDeclarations) return output;

  const declarations = await compileProject({
    project,
    projectPath: options.project,
    compilerOptions: { ...options, outputStructure: 'message-modules' },
  });
  for (const [file, content] of Object.entries(declarations)) {
    if (file.endsWith('.d.ts')) output[file] = content;
  }

  return output;
}
