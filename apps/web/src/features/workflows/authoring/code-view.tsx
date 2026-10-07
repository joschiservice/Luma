import type {
  AuthoringVocabulary,
  DraftValidation,
  WorkflowDiagnostic,
  WorkflowDraftContent,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import type {
  CodeEditorCompletion,
  CodeEditorDiagnostic,
} from '@luma/ui/components/primitives/code-editor';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { workflowError } from '../data';
import { validateDraft } from './data';
import { LazyCodeEditor } from './lazy-code-editor';

const narrowQuery = '(max-width: 760px)';

/** Tracks whether the viewport is narrow, where code is shown read-only. */
export function useNarrow() {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(narrowQuery);
      query.addEventListener('change', notify);

      return () => query.removeEventListener('change', notify);
    },
    () => window.matchMedia(narrowQuery).matches,
    () => false,
  );
}

function lineOf(text: string, pattern: string, from = 1) {
  const lines = text.split('\n');
  for (let index = Math.max(from - 1, 0); index < lines.length; index++)
    if (lines[index]!.includes(pattern)) return index + 1;

  return null;
}

/** Places server diagnostics on the lines of code they refer to. */
export function codeDiagnostics(
  text: string,
  diagnostics: WorkflowDiagnostic[],
): CodeEditorDiagnostic[] {
  return diagnostics.map((item) => {
    const parse = /at (\d+):(\d+)$/.exec(item.detail);
    if (item.code === 'code_parse' && parse)
      return {
        line: Number(parse[1]),
        column: Number(parse[2]),
        severity: 'error' as const,
        message: item.message,
      };
    const stepLine = item.stepId ? lineOf(text, `id: '${item.stepId}'`) : null;
    const last = item.field?.split('.').at(-1);
    const fieldLine = last ? lineOf(text, `${last}:`, stepLine ?? 1) : null;

    return {
      line: fieldLine ?? stepLine ?? 1,
      severity: item.severity,
      message: item.message,
    };
  });
}

/** Suggests names from the workspace vocabulary while editing workflow code. */
export function vocabularyCompletions(
  vocabulary: AuthoringVocabulary,
): CodeEditorCompletion[] {
  return [
    ...vocabulary.stepKinds.map((item) => ({
      label: `'${item.kind}'`,
      detail: item.label,
      type: 'constant' as const,
    })),
    ...vocabulary.capabilities.map((item) => ({
      label: `'${item.capability}'`,
      detail: `${item.label} · version ${item.version}`,
      type: 'constant' as const,
    })),
    ...vocabulary.reads.map((item) => ({
      label: `'${item.source}'`,
      detail: item.label,
      type: 'constant' as const,
    })),
    ...vocabulary.evaluators.map((item) => ({
      label: `'${item.version}'`,
      detail: item.label,
      type: 'constant' as const,
    })),
    ...vocabulary.subjects.map((item) => ({
      label: `'${item.kind}'`,
      detail: item.label,
      type: 'constant' as const,
    })),
  ];
}

/**
 * Edits the whole draft as TypeScript. Text is parsed on the server without evaluating it; valid
 * text updates the draft, and problems appear on their lines. Narrow screens show it read-only.
 */
export function DraftCodeView({
  organizationId,
  initial,
  vocabulary,
  readOnly,
  onChange,
}: {
  organizationId: string;
  initial: string;
  vocabulary: AuthoringVocabulary;
  readOnly: boolean;
  onChange(content: WorkflowDraftContent, code: string): void;
}) {
  const narrow = useNarrow();
  const [text, setText] = useState(initial);
  const [result, setResult] = useState<DraftValidation | null>(null);
  const [error, setError] = useState('');
  const change = useRef(onChange);
  const edited = useRef(false);

  useLayoutEffect(() => {
    change.current = onChange;
  });

  useEffect(() => {
    if (!edited.current) setText(initial);
  }, [initial]);

  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(() => {
      validateDraft(organizationId, { code: text }, abort.signal)
        .then((validation) => {
          setResult(validation);
          setError('');
          if (edited.current && validation.content)
            change.current(validation.content, text);
        })
        .catch((failure) => {
          if (!abort.signal.aborted) setError(workflowError(failure));
        });
    }, 400);

    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [organizationId, text]);

  const parseProblem = result?.diagnostics.find(
    (item) => item.code === 'code_parse',
  );

  return (
    <div className="authoring-code-view">
      {narrow || readOnly ? (
        <Alert tone="neutral" className="workflow-notice">
          {readOnly
            ? 'You can review the code. Changing drafts requires Author workflows.'
            : 'Code is read-only on small screens. Use a wider screen to edit it.'}
        </Alert>
      ) : (
        <p className="authoring-hint" id="authoring-code-help">
          The code is read as data, never run. Use literal values only. Code
          Step source goes between <code>code`</code> backticks.
        </p>
      )}
      <LazyCodeEditor
        label="Workflow code"
        describedBy="authoring-code-help"
        value={text}
        readOnly={narrow || readOnly}
        onChange={(value) => {
          edited.current = true;
          setText(value);
        }}
        diagnostics={codeDiagnostics(text, result?.diagnostics ?? [])}
        completions={vocabularyCompletions(vocabulary)}
        className="authoring-code-editor"
      />
      <div role="status" className="authoring-code-status">
        {error
          ? `Couldn’t check the code. ${error}`
          : parseProblem
            ? `Not saved: ${parseProblem.message}`
            : result
              ? result.diagnostics.some((item) => item.severity === 'error')
                ? 'Saved. Fix the problems shown before publishing.'
                : 'Code matches the draft.'
              : 'Checking…'}
      </div>
    </div>
  );
}
