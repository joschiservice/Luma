import { m } from '@luma/i18n/messages';
import type { CodeEditor as Editor } from '@luma/ui/components/primitives/code-editor';
import { type ComponentProps, lazy, Suspense } from 'react';

const CodeEditor = lazy(() =>
  import('@luma/ui/components/primitives/code-editor').then((module) => ({
    default: module.CodeEditor,
  })),
);

/** Loads the code editor only when code is shown, keeping it out of the builder's bundle. */
export function LazyCodeEditor(props: ComponentProps<typeof Editor>) {
  return (
    <Suspense
      fallback={<p role="status">{m.authoring_code_editor_loading()}</p>}
    >
      <CodeEditor {...props} />
    </Suspense>
  );
}
