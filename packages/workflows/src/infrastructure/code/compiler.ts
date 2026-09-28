import ts from 'typescript';

/** Erases TypeScript types without executing source or resolving external dependencies. */
export function compileCodeSource(source: string): string {
  if (Buffer.byteLength(source) > 32768)
    throw new Error('Code source exceeds limit');
  const file = ts.createSourceFile(
    'step.ts',
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  let invalid = false;
  let main = false;

  function visit(node: ts.Node) {
    if (
      node.kind === ts.SyntaxKind.ImportKeyword ||
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node) ||
      ts.isAwaitExpression(node)
    )
      invalid = true;
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === 'main' &&
      node.parent === file
    )
      main = true;
    if (
      ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some((m) =>
          [ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.AsyncKeyword].includes(
            m.kind,
          ),
        )
    )
      invalid = true;
    ts.forEachChild(node, visit);
  }

  visit(file);
  const result = ts.transpileModule(source, {
    fileName: 'step.ts',
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
      strict: true,
    },
  });
  if (
    !main ||
    invalid ||
    result.diagnostics?.some((d) => d.category === ts.DiagnosticCategory.Error)
  ) {
    throw new Error(
      'Provide a synchronous main(input, luma) function without module imports or exports.',
    );
  }

  return result.outputText;
}
