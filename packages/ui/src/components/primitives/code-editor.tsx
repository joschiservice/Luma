import {
  autocompletion,
  type Completion,
  type CompletionContext,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { type Diagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
import { Compartment, EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useLayoutEffect, useRef } from 'react';

import { cn } from '../../lib/utils';

/** A problem shown on a 1-based line, optionally from a column to the end of a range. */
export interface CodeEditorDiagnostic {
  line: number;
  column?: number;
  endLine?: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

/** A suggestion offered while typing, such as a field path or a granted step ID. */
export interface CodeEditorCompletion {
  label: string;
  detail?: string;
  info?: string;
  type?: 'variable' | 'property' | 'function' | 'constant' | 'text';
}

const theme = EditorView.theme({
  '&': {
    backgroundColor: '#0b1020',
    color: '#dbe3f2',
    fontSize: '12px',
    borderRadius: 'var(--radius-panel, 10px)',
  },
  '&.cm-focused': {
    outline: '2px solid var(--ring, #316bff)',
    outlineOffset: '2px',
  },
  '.cm-content': {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    lineHeight: '1.75',
    caretColor: '#ffffff',
  },
  '.cm-gutters': {
    backgroundColor: '#0b1020',
    color: '#8c96ab',
    border: 'none',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: '#ffffff0d',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: '#316bff55',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface-raised, #ffffff)',
    color: 'var(--foreground, #15171c)',
    border: '1px solid var(--line-strong, #15171c26)',
    borderRadius: '8px',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--surface-selected, #316bff14)',
    color: 'var(--foreground, #15171c)',
  },
});

// Every colour keeps at least 4.5:1 contrast on the editor background.
const highlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.modifier, tags.operatorKeyword],
    color: '#c9b3ff',
  },
  { tag: [tags.string, tags.special(tags.string)], color: '#a6e3b0' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: '#ffd08f' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: '#a3adc2',
    fontStyle: 'italic',
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: '#9fd0ff',
  },
  { tag: [tags.typeName, tags.className], color: '#8ee6dc' },
  {
    tag: [
      tags.propertyName,
      tags.variableName,
      tags.definition(tags.variableName),
    ],
    color: '#dbe3f2',
  },
  { tag: [tags.punctuation, tags.operator, tags.bracket], color: '#c3cbdb' },
  { tag: tags.invalid, color: '#ffb4b4' },
]);

function position(doc: EditorState['doc'], line: number, column = 1) {
  const bounded = doc.line(Math.min(Math.max(line, 1), doc.lines));

  return Math.min(bounded.from + Math.max(column - 1, 0), bounded.to);
}

function toDiagnostics(
  state: EditorState,
  items: CodeEditorDiagnostic[],
): Diagnostic[] {
  return items.map((item) => {
    const from = position(state.doc, item.line, item.column);
    const endLine = state.doc.line(
      Math.min(Math.max(item.endLine ?? item.line, 1), state.doc.lines),
    );

    return {
      from,
      to: Math.max(from, item.column ? from + 1 : endLine.to),
      severity: item.severity,
      message: item.message,
    };
  });
}

/**
 * Edits TypeScript or plain text with line numbers, suggestions and inline diagnostics. Tab moves
 * focus out of the editor so keyboard users are never trapped. The editor never runs the code.
 */
export function CodeEditor({
  value,
  onChange,
  label,
  describedBy,
  readOnly = false,
  language = 'typescript',
  diagnostics = [],
  completions = [],
  className,
}: {
  value: string;
  onChange?: (value: string) => void;
  label: string;
  describedBy?: string | undefined;
  readOnly?: boolean;
  language?: 'typescript' | 'plain';
  diagnostics?: CodeEditorDiagnostic[];
  completions?: CodeEditorCompletion[];
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  const suggestions = useRef(completions);
  const editable = useRef(new Compartment());
  const attributes = useRef(new Compartment());

  useLayoutEffect(() => {
    change.current = onChange;
    suggestions.current = completions;
  });

  useEffect(() => {
    const complete = (context: CompletionContext) => {
      const word = context.matchBefore(/[\w$.'"-]*/);
      if (!word || (word.from === word.to && !context.explicit)) return null;
      const options: Completion[] = suggestions.current.map((item) => ({
        label: item.label,
        ...(item.detail ? { detail: item.detail } : {}),
        ...(item.info ? { info: item.info } : {}),
        type: item.type ?? 'variable',
      }));

      return { from: word.from, options, validFor: /^[\w$.'"-]*$/ };
    };
    const created = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(highlight),
          ...(language === 'typescript'
            ? [javascript({ typescript: true })]
            : []),
          autocompletion({ override: [complete] }),
          lintGutter(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          theme,
          editable.current.of([
            EditorState.readOnly.of(readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          attributes.current.of(
            EditorView.contentAttributes.of({
              'aria-label': label,
              ...(describedBy ? { 'aria-describedby': describedBy } : {}),
            }),
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              change.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = created;

    return () => {
      created.destroy();
      view.current = null;
    };
    // The editor is created once; later prop changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  useEffect(() => {
    const current = view.current;
    if (!current || current.state.doc.toString() === value) return;
    current.dispatch({
      changes: { from: 0, to: current.state.doc.length, insert: value },
    });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: [
        editable.current.reconfigure([
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
        ]),
        attributes.current.reconfigure(
          EditorView.contentAttributes.of({
            'aria-label': label,
            ...(describedBy ? { 'aria-describedby': describedBy } : {}),
            ...(readOnly ? { 'aria-readonly': 'true' } : {}),
          }),
        ),
      ],
    });
  }, [readOnly, label, describedBy]);

  useEffect(() => {
    const current = view.current;
    if (!current) return;
    current.dispatch(
      setDiagnostics(current.state, toDiagnostics(current.state, diagnostics)),
    );
  }, [diagnostics, value]);

  return (
    <div
      ref={host}
      data-slot="code-editor"
      className={cn('min-h-40 overflow-hidden', className)}
    />
  );
}
