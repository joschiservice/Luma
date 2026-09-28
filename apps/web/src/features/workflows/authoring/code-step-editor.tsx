import type {
  DraftStep,
  ValueOption,
  WorkflowDiagnostic,
  WorkflowDraftContent,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import type { CodeEditorCompletion } from '@luma/ui/components/primitives/code-editor';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Input } from '@luma/ui/components/primitives/input';
import { type ReactNode, useState } from 'react';

import { type FieldType, humanize } from './draft-model';
import { LazyCodeEditor } from './lazy-code-editor';
import { Field, FieldListEditor, FieldProblems } from './step-forms';

type CodeStep = Extract<DraftStep, { kind: 'code' }>;

const unsupported: [RegExp, string][] = [
  [
    /^\s*import\b|\bimport\s*\(/m,
    'Imports aren’t supported. Code Steps can’t load packages.',
  ],
  [
    /^\s*export\b/m,
    'Remove export. Declare function main(input, luma) instead.',
  ],
  [
    /\basync\b|\bawait\b/,
    'Async code isn’t supported. Code Steps run synchronously.',
  ],
  [
    /\brequire\s*\(/,
    'require() isn’t supported. Code Steps can’t load packages.',
  ],
];

/** Flags features Code Steps never support, before the source is saved. */
export function unsupportedFeatures(source: string) {
  const found = unsupported
    .filter(([pattern]) => pattern.test(source))
    .map(([, message]) => message);
  if (!/\bfunction\s+main\s*\(/.test(source))
    found.push('Declare a function named main(input, luma).');

  return found;
}

/** Offers `input` fields and granted steps for completion inside Code Step source. */
export function codeStepCompletions(
  scope: ValueOption[],
  grants: string[],
): CodeEditorCompletion[] {
  return [
    ...scope.map((item) => ({
      label:
        item.source === 'step'
          ? `input.steps.${item.stepId}.${item.field}`
          : `input.${item.source === 'input' ? 'inputs' : 'evidence'}.${item.field}`,
      detail: item.type,
      type: 'property' as const,
    })),
    ...grants.map((grant) => ({
      label: `luma.request('${grant}')`,
      detail: 'granted step',
      type: 'function' as const,
    })),
    { label: 'luma.now', detail: 'run start time', type: 'property' as const },
  ];
}

/** Steps a Code Step may request: the reads and actions right after it, in order. */
export function grantable(content: WorkflowDraftContent, index: number) {
  const found: string[] = [];
  for (let next = index + 1; next < content.steps.length;) {
    const step = content.steps[next]!;
    if (step.kind === 'read') {
      found.push(step.id);
      next++;
    } else if (step.kind === 'capability') {
      found.push(step.id);
      next += 2;
    } else break;
  }

  return found;
}

/**
 * Edits Code Step source, returned fields and granted steps. The source is never run here; it runs
 * only in the sandbox when tested or after publication.
 */
export function CodeStepEditor({
  step,
  index,
  content,
  scope,
  diagnostics,
  readOnly,
  apply,
  close,
  tools,
}: {
  step: CodeStep;
  index: number;
  content: WorkflowDraftContent;
  scope: ValueOption[];
  diagnostics: WorkflowDiagnostic[];
  readOnly: boolean;
  apply(step: CodeStep): void;
  close(): void;
  tools?: (props: {
    step: CodeStep;
    replace(next: Pick<CodeStep, 'source' | 'fields' | 'grants'>): void;
  }) => ReactNode;
}) {
  const [draft, setDraft] = useState(step);
  const problems = unsupportedFeatures(draft.source);
  const available = grantable(content, index);

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="workflow-dialog authoring-code-dialog">
        <DialogTitle>Code Step “{step.id}”</DialogTitle>
        <DialogDescription>
          Write a synchronous main(input, luma) function that returns the
          declared fields. It runs in a sandbox with no network or packages.
        </DialogDescription>
        <LazyCodeEditor
          label="TypeScript source"
          value={draft.source}
          readOnly={readOnly}
          onChange={(source) => setDraft((current) => ({ ...current, source }))}
          completions={codeStepCompletions(scope, draft.grants)}
          diagnostics={[
            ...problems.map((message) => ({
              line: 1,
              severity: 'error' as const,
              message,
            })),
          ]}
          className="authoring-code-editor"
        />
        {problems.length ? (
          <Alert tone="danger" role="alert">
            <ul>
              {problems.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        <FieldProblems
          id={`code-step-${step.id}-problems`}
          diagnostics={diagnostics}
        />
        <div className="authoring-code-columns">
          <div>
            <h3>Available as input</h3>
            {scope.length ? (
              <ul className="authoring-code-inputs">
                {scope.map((item) => (
                  <li key={`${item.source}:${item.stepId}:${item.field}`}>
                    <code>
                      {item.source === 'step'
                        ? `input.steps.${item.stepId}.${item.field}`
                        : `input.${item.source === 'input' ? 'inputs' : 'evidence'}.${item.field}`}
                    </code>{' '}
                    <span className="authoring-hint">{item.type}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="authoring-hint">
                No inputs or earlier outputs yet.
              </p>
            )}
          </div>
          <FieldListEditor
            label="Returned fields"
            fields={draft.fields as Record<string, FieldType>}
            disabled={readOnly}
            onChange={(fields) =>
              setDraft((current) => ({ ...current, fields }))
            }
          />
        </div>
        <fieldset className="authoring-choices">
          <legend>Steps this code may request</legend>
          {available.length ? null : (
            <p className="authoring-hint">
              Put a read or action right after this Code Step to let it request
              one.
            </p>
          )}
          {available.map((grant) => (
            <label key={grant}>
              <input
                type="checkbox"
                disabled={readOnly}
                checked={draft.grants.includes(grant)}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    grants: event.target.checked
                      ? available.filter(
                          (item) =>
                            item === grant || current.grants.includes(item),
                        )
                      : current.grants.filter((item) => item !== grant),
                  }))
                }
              />
              {humanize(grant)} <code>luma.request('{grant}')</code>
            </label>
          ))}
        </fieldset>
        <Field label="Time limit in milliseconds">
          {(props) => (
            <Input
              {...props}
              type="number"
              min="100"
              max="30000"
              disabled={readOnly}
              value={draft.limits.wallTimeMs}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  limits: {
                    ...current.limits,
                    wallTimeMs: Number(event.target.value || 100),
                  },
                }))
              }
            />
          )}
        </Field>
        {tools?.({
          step: draft,
          replace: (next) => setDraft((current) => ({ ...current, ...next })),
        })}
        <div className="workflow-dialog-actions">
          <Button variant="outline" onClick={close}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          {!readOnly ? (
            <Button
              disabled={problems.length > 0}
              onClick={() =>
                apply({
                  ...draft,
                  limits: {
                    ...draft.limits,
                    maxRequests: Math.max(
                      draft.limits.maxRequests,
                      draft.grants.length,
                    ),
                  },
                })
              }
            >
              Apply to draft
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
