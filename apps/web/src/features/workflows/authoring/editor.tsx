import './authoring.css';

import type {
  AuthoringMode,
  AuthoringVocabulary,
  DraftValidation,
  SaveWorkflowDraft,
  WorkflowDiagnostic,
  WorkflowDraft,
  WorkflowDraftContent,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@luma/ui/components/primitives/tabs';
import { WorkspaceBreadcrumb } from '@luma/ui/components/workspace/workspace-breadcrumb';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { ChevronRight, Redo2, Undo2, Workflow } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { SignInRedirect } from '../../../kit/identity/common';
import { ApiError, contextOptions } from '../../../kit/identity/data';
import { usePermissions } from '../../../kit/identity/permissions';
import { workflowError, workflowsKey } from '../data';
import { WorkflowLoading } from '../library';
import { OfflineNotice } from '../offline';
import { type BuilderFocus, WorkflowBuilder } from './builder';
import { CodeStepEditor } from './code-step-editor';
import { DraftCodeView } from './code-view';
import {
  discardDraft,
  draftOptions,
  draftsKey,
  saveDraft,
  validateDraft,
  vocabularyOptions,
} from './data';
import { CodeStepSuggester, GenerationAssistant } from './describe';
import { updateStep } from './draft-model';
import { PublishDialog } from './publish';
import { DraftTestPanel, PublishTestSummary, useTestRerun } from './tests';

export type EditorView = 'build' | 'code' | 'test';

/** Validates the editor view in shareable URLs. */
export function parseEditorSearch(value: Record<string, unknown>): {
  view: EditorView;
} {
  return {
    view: value.view === 'code' || value.view === 'test' ? value.view : 'build',
  };
}

type SaveStatus =
  | 'saved'
  | 'unsaved'
  | 'saving'
  | 'retrying'
  | 'conflict'
  | 'failed'
  | 'forbidden';

interface Snapshot {
  content: WorkflowDraftContent;
  codeView: string | null;
  mode: AuthoringMode;
}

const statusText = {
  saved: m.authoring_save_saved,
  unsaved: m.authoring_save_unsaved,
  saving: m.common_saving,
  retrying: m.authoring_save_retrying,
  conflict: m.authoring_save_conflict,
  failed: m.authoring_save_failed,
  forbidden: m.authoring_save_forbidden,
} satisfies Record<SaveStatus, () => string>;

/**
 * Keeps local edits, autosaves them against the loaded revision and never overwrites someone
 * else's save. An uncertain save is retried with the same save ID and body.
 */
function useDraftSession(
  organizationId: string,
  initial: WorkflowDraft,
  editable: boolean,
) {
  const client = useQueryClient();
  const [snapshot, setSnapshot] = useState<Snapshot>({
    content: initial.content,
    codeView: initial.codeView,
    mode: initial.mode,
  });
  const [draft, setDraft] = useState(initial);
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [error, setError] = useState('');
  const [history, setHistory] = useState<{
    past: Snapshot[];
    future: Snapshot[];
  }>({ past: [], future: [] });
  const [tick, setTick] = useState(0);
  const latest = useRef(snapshot);
  const revision = useRef(initial.revision);
  const retry = useRef<SaveWorkflowDraft | null>(null);
  const saving = useRef(false);

  useLayoutEffect(() => {
    latest.current = snapshot;
  });

  const save = useCallback(async () => {
    if (saving.current) return;
    const body: SaveWorkflowDraft = retry.current ?? {
      saveId: crypto.randomUUID(),
      revision: revision.current,
      mode: latest.current.mode,
      content: latest.current.content,
      codeView: latest.current.codeView,
    };
    saving.current = true;
    setStatus(retry.current ? 'retrying' : 'saving');
    try {
      const saved = await saveDraft(organizationId, initial.id, body);
      retry.current = null;
      revision.current = saved.revision;
      setDraft(saved);
      client.setQueryData(
        draftOptions(organizationId, initial.id).queryKey,
        saved,
      );
      setError('');
      setStatus(
        latest.current.content === body.content &&
          latest.current.codeView === (body.codeView ?? null)
          ? 'saved'
          : 'unsaved',
      );
    } catch (failure) {
      setError(workflowError(failure));
      if (failure instanceof ApiError && failure.status === 409)
        setStatus('conflict');
      else if (
        failure instanceof ApiError &&
        [401, 403, 404].includes(failure.status)
      )
        setStatus('forbidden');
      else {
        retry.current = body;
        setStatus('failed');
      }
    } finally {
      saving.current = false;
      // Edits made while this save was in flight are saved next.
      setTick((value) => value + 1);
    }
  }, [client, initial.id, organizationId]);

  useEffect(() => {
    if (status !== 'unsaved' || !editable) return;
    const timer = setTimeout(() => void save(), 800);

    return () => clearTimeout(timer);
  }, [snapshot, status, editable, save, tick]);

  const change = (next: Partial<Snapshot>) => {
    if (!editable || ['conflict', 'forbidden'].includes(status)) return;
    setHistory({ past: [...history.past.slice(-99), snapshot], future: [] });
    setSnapshot({ ...snapshot, ...next });
    if (status !== 'failed') setStatus('unsaved');
  };

  const undo = () => {
    const target = history.past.at(-1);
    if (!target || !editable) return;
    setHistory({
      past: history.past.slice(0, -1),
      future: [...history.future, snapshot],
    });
    setSnapshot(target);
    setStatus('unsaved');
  };

  const redo = () => {
    const target = history.future.at(-1);
    if (!target || !editable) return;
    setHistory({
      past: [...history.past, snapshot],
      future: history.future.slice(0, -1),
    });
    setSnapshot(target);
    setStatus('unsaved');
  };

  return {
    draft,
    snapshot,
    status,
    error,
    change,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    retrySave: () => void save(),
  };
}

/**
 * Checks the working copy on the server shortly after each change, so broken references appear
 * immediately. The result records which content it describes.
 */
function useLiveValidation(
  organizationId: string,
  draftId: string,
  content: WorkflowDraftContent,
) {
  const [result, setResult] = useState<{
    validation: DraftValidation;
    content: WorkflowDraftContent;
  } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(() => {
      validateDraft(organizationId, { draftId, content }, abort.signal)
        .then((validation) => {
          setResult({ validation, content });
          setError('');
        })
        .catch((failure) => {
          if (!abort.signal.aborted) setError(workflowError(failure));
        });
    }, 300);

    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [organizationId, draftId, content]);

  return { validation: result?.validation, validated: result?.content, error };
}

/** Loads a draft and the workspace vocabulary, then opens the editor. */
export function DraftEditorPage({
  testPanel,
  assistant,
}: {
  testPanel?: DraftEditorProps['testPanel'];
  assistant?: DraftEditorProps['assistant'];
}) {
  const { organizationId, draftId } = useParams({
    from: '/app/$organizationId/workflows/drafts/$draftId',
  });
  const { view } = useSearch({
    from: '/app/$organizationId/workflows/drafts/$draftId',
  });
  const navigate = useNavigate();
  const [generation, setGeneration] = useState(0);
  const draft = useQuery(draftOptions(organizationId, draftId));
  const vocabulary = useQuery(vocabularyOptions(organizationId));
  const context = useQuery(contextOptions(organizationId));
  const permissions = usePermissions(organizationId);
  const failure = draft.error ?? vocabulary.error;
  if (failure instanceof ApiError && failure.status === 401)
    return <SignInRedirect />;

  return (
    <div className="workflows-page authoring-page">
      <OfflineNotice />
      {failure ? (
        <Alert tone="danger" role="alert" className="workflow-notice">
          <span>
            {failure instanceof ApiError && failure.status === 404
              ? m.authoring_draft_not_found()
              : workflowError(failure)}
          </span>
          <Link to="/app/$organizationId/workflows" params={{ organizationId }}>
            {m.authoring_back_to_workflows()}
          </Link>
        </Alert>
      ) : !draft.data || !vocabulary.data || !context.data ? (
        <WorkflowLoading detail />
      ) : (
        <DraftEditor
          key={`${draft.data.id}:${generation}`}
          organizationId={organizationId}
          draft={draft.data}
          vocabulary={vocabulary.data}
          canManage={permissions.can('workflows.author')}
          view={view}
          setView={(next) =>
            void navigate({
              to: '/app/$organizationId/workflows/drafts/$draftId',
              params: { organizationId, draftId },
              search: { view: next },
              replace: true,
            })
          }
          reload={() =>
            void draft.refetch().then(() => setGeneration((value) => value + 1))
          }
          testPanel={testPanel ?? ((props) => <DraftTestPanel {...props} />)}
          publishTests={({ draft: current }) => (
            <PublishTestSummary
              organizationId={organizationId}
              draft={current}
            />
          )}
          assistant={
            assistant ?? ((props) => <GenerationAssistant {...props} />)
          }
          codeStepTools={(props) => (
            <CodeStepSuggester organizationId={organizationId} {...props} />
          )}
        />
      )}
    </div>
  );
}

export interface DraftEditorProps {
  organizationId: string;
  draft: WorkflowDraft;
  vocabulary: AuthoringVocabulary;
  canManage: boolean;
  view: EditorView;
  setView(view: EditorView): void;
  reload(): void;
  testPanel?:
    | ((props: {
        organizationId: string;
        draft: WorkflowDraft;
        saved: boolean;
        canManage: boolean;
        content: WorkflowDraftContent;
        validation: DraftValidation | undefined;
      }) => ReactNode)
    | undefined;
  publishTests?: ((props: { draft: WorkflowDraft }) => ReactNode) | undefined;
  assistant?:
    | ((props: {
        organizationId: string;
        draft: WorkflowDraft;
        editable: boolean;
        saved: boolean;
        reload(): void;
        highlight(
          questions: {
            stepId: string | null;
            field: string;
            question: string;
          }[],
        ): void;
      }) => ReactNode)
    | undefined;
  codeStepTools?:
    | ((props: {
        draft: WorkflowDraft;
        stepId: string;
        replace(next: {
          source: string;
          fields: Record<string, 'string' | 'number' | 'boolean' | 'null'>;
          grants: string[];
        }): void;
      }) => ReactNode)
    | undefined;
}

/** Edits one draft in the builder, code or test view, then publishes the saved revision. */
export function DraftEditor({
  organizationId,
  draft: loaded,
  vocabulary,
  canManage,
  view,
  setView,
  reload,
  testPanel,
  publishTests,
  assistant,
  codeStepTools,
}: DraftEditorProps) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const editable = canManage && loaded.state === 'draft';
  const session = useDraftSession(organizationId, loaded, editable);
  const { snapshot, draft, status } = session;
  const live = useLiveValidation(organizationId, draft.id, snapshot.content);
  useTestRerun({
    organizationId,
    draft,
    saved: status === 'saved' && !!testPanel,
    canManage: editable,
  });
  const validation = live.validation;
  const [focus, setFocus] = useState<BuilderFocus | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [codeStep, setCodeStep] = useState<number | null>(null);
  const [questions, setQuestions] = useState<
    { stepId: string | null; field: string; question: string }[]
  >([]);
  const readOnly = !editable || status === 'conflict' || status === 'forbidden';
  const current = live.validated === snapshot.content;
  const printed = current ? (validation?.printed ?? null) : null;
  const formatted =
    snapshot.codeView !== null &&
    printed !== null &&
    live.validated === snapshot.content &&
    snapshot.codeView !== printed;
  const errors =
    validation?.diagnostics.filter((item) => item.severity === 'error') ?? [];
  const warnings =
    validation?.diagnostics.filter((item) => item.severity === 'warning') ?? [];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== 'z'
      )
        return;
      event.preventDefault();
      if (event.shiftKey) session.redo();
      else session.undo();
    };
    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  });

  const select = (item: WorkflowDiagnostic) => {
    setView('build');
    setFocus({ stepIndex: item.stepIndex, field: item.field });
  };

  return (
    <>
      <WorkspaceBreadcrumb>
        <Workflow size={16} aria-hidden="true" />
        <Link to="/app/$organizationId/workflows" params={{ organizationId }}>
          {m.authoring_breadcrumb_workflows()}
        </Link>
        <ChevronRight size={14} aria-hidden="true" />
        <span aria-current="page">
          {snapshot.content.definition.name || m.authoring_untitled()}
        </span>
      </WorkspaceBreadcrumb>
      <div className="authoring-editor-bar">
        <div className="authoring-editor-title">
          <p className="workflow-eyebrow">
            {draft.basedOn
              ? m.authoring_editor_based_on({
                  workflow: draft.basedOn.definitionId,
                  version: draft.basedOn.version,
                })
              : m.authoring_gallery_title()}
          </p>
          <h1>{snapshot.content.definition.name || m.authoring_untitled()}</h1>
        </div>
        <Badge tone={draft.state === 'published' ? 'success' : 'neutral'}>
          {draft.state === 'published'
            ? m.authoring_editor_published_badge({
                version: draft.published?.version ?? '',
              })
            : m.authoring_editor_draft_badge({
                version: snapshot.content.version,
              })}
        </Badge>
        <span
          className="authoring-save-status"
          role="status"
          aria-live="polite"
        >
          {editable ? statusText[status]() : m.authoring_editor_view_only()}
        </span>
        {editable ? (
          <div className="authoring-editor-actions">
            <Button
              variant="ghost"
              size="icon"
              aria-label={m.authoring_editor_undo()}
              title={m.authoring_editor_undo_shortcut()}
              disabled={!session.canUndo || readOnly}
              onClick={session.undo}
            >
              <Undo2 aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={m.authoring_editor_redo()}
              title={m.authoring_editor_redo_shortcut()}
              disabled={!session.canRedo || readOnly}
              onClick={session.redo}
            >
              <Redo2 aria-hidden="true" />
            </Button>
            <Button variant="outline" onClick={() => setDiscarding(true)}>
              {m.authoring_editor_discard()}
            </Button>
            <Button
              disabled={status !== 'saved' || !current || readOnly}
              onClick={() => setPublishing(true)}
            >
              {m.authoring_editor_publish()}
            </Button>
          </div>
        ) : null}
      </div>
      {!canManage ? (
        <Alert tone="neutral" className="workflow-notice">
          {m.authoring_editor_view_only_notice()}
        </Alert>
      ) : null}
      {draft.state === 'published' && draft.published ? (
        <Alert tone="success" className="workflow-notice">
          <span>
            {m.authoring_editor_published_notice({
              version: draft.published.version,
            })}
          </span>
          <Link
            to="/app/$organizationId/workflows/$definitionId"
            params={{
              organizationId,
              definitionId: snapshot.content.definition.id,
            }}
          >
            {m.authoring_open_workflow()}
          </Link>
        </Alert>
      ) : null}
      {status === 'conflict' ? (
        <Alert tone="warning" role="alert" className="workflow-notice">
          <span>{m.authoring_editor_conflict()}</span>
          <Button variant="outline" onClick={reload}>
            {m.authoring_editor_reload()}
          </Button>
        </Alert>
      ) : status === 'failed' ? (
        <Alert tone="danger" role="alert" className="workflow-notice">
          <span>
            {m.authoring_editor_save_failed({ error: session.error })}
          </span>
          <Button variant="outline" onClick={session.retrySave}>
            {m.authoring_editor_retry_save()}
          </Button>
        </Alert>
      ) : status === 'forbidden' ? (
        <Alert tone="danger" role="alert" className="workflow-notice">
          {session.error}
        </Alert>
      ) : null}
      {live.error ? (
        <Alert tone="warning" className="workflow-notice">
          {m.authoring_editor_check_failed({ error: live.error })}
        </Alert>
      ) : null}
      <section
        className="authoring-overview"
        aria-label={m.authoring_editor_summary_label()}
      >
        <p className="authoring-summary">
          {validation?.summary ?? m.authoring_editor_checking()}
        </p>
        <div className="authoring-counts">
          <Badge
            tone={
              !validation || !current
                ? 'neutral'
                : errors.length
                  ? 'danger'
                  : 'success'
            }
          >
            {!validation || !current
              ? m.authoring_checking()
              : errors.length
                ? m.authoring_editor_blocking({ count: errors.length })
                : m.authoring_editor_ready()}
          </Badge>
          {warnings.length ? (
            <Badge tone="warning">
              {m.authoring_editor_limited({ count: warnings.length })}
            </Badge>
          ) : null}
        </div>
        {errors.length || warnings.length ? (
          <Disclosure className="authoring-problems">
            <summary>{m.authoring_editor_show_problems()}</summary>
            <ul>
              {[...errors, ...warnings].map((item, index) => (
                <li
                  key={`${item.code}:${item.stepIndex}:${item.field}:${index}`}
                  data-severity={item.severity}
                >
                  <button type="button" onClick={() => select(item)}>
                    <strong>
                      {item.stepIndex === null
                        ? m.authoring_workflow_settings()
                        : item.stepId
                          ? m.authoring_editor_problem_step_named({
                              position: item.stepIndex + 1,
                              step: item.stepId,
                            })
                          : m.authoring_editor_problem_step({
                              position: item.stepIndex + 1,
                            })}
                    </strong>
                    <span>{item.message}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}
      </section>
      {assistant?.({
        organizationId,
        draft,
        editable: !readOnly,
        saved: status === 'saved',
        reload,
        highlight: setQuestions,
      })}
      <Tabs
        value={view}
        onValueChange={(value) => setView(value as EditorView)}
        className="authoring-tabs"
      >
        <TabsList aria-label={m.authoring_editor_tabs_label()}>
          <TabsTrigger value="build">
            {m.authoring_editor_tab_build()}
          </TabsTrigger>
          <TabsTrigger value="code">
            {m.authoring_editor_tab_code()}
          </TabsTrigger>
          {testPanel ? (
            <TabsTrigger value="test">
              {m.authoring_editor_tab_test()}
            </TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="build">
          {formatted ? (
            <Alert tone="neutral" className="workflow-notice">
              <span>{m.authoring_editor_formatted()}</span>
              {!readOnly ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    session.change({ codeView: null, mode: 'visual' })
                  }
                >
                  {m.authoring_editor_use_standard_format()}
                </Button>
              ) : null}
            </Alert>
          ) : null}
          <WorkflowBuilder
            content={snapshot.content}
            validation={current ? validation : undefined}
            vocabulary={vocabulary}
            readOnly={readOnly || formatted}
            focus={focus}
            highlights={questions}
            openCode={setCodeStep}
            onChange={(content) =>
              session.change({ content, codeView: null, mode: 'visual' })
            }
          />
        </TabsContent>
        <TabsContent value="code">
          {printed !== null || snapshot.codeView !== null ? (
            <DraftCodeView
              organizationId={organizationId}
              initial={snapshot.codeView ?? printed ?? ''}
              vocabulary={vocabulary}
              readOnly={readOnly}
              onChange={(content, code) =>
                session.change({ content, codeView: code, mode: 'code' })
              }
            />
          ) : (
            <p role="status">{m.authoring_editor_preparing_code()}</p>
          )}
        </TabsContent>
        {testPanel ? (
          <TabsContent value="test">
            {testPanel({
              organizationId,
              draft,
              saved: status === 'saved',
              canManage: editable,
              content: snapshot.content,
              validation,
            })}
          </TabsContent>
        ) : null}
      </Tabs>
      {codeStep !== null &&
      snapshot.content.steps[codeStep]?.kind === 'code' ? (
        <CodeStepEditor
          step={
            snapshot.content.steps[codeStep] as Extract<
              WorkflowDraftContent['steps'][number],
              { kind: 'code' }
            >
          }
          index={codeStep}
          content={snapshot.content}
          scope={validation?.steps[codeStep]?.scope ?? []}
          diagnostics={(validation?.diagnostics ?? []).filter(
            (item) => item.stepIndex === codeStep,
          )}
          readOnly={readOnly}
          {...(codeStepTools && !readOnly && status === 'saved'
            ? {
                tools: ({ step, replace }) =>
                  codeStepTools({ draft, stepId: step.id, replace }),
              }
            : {})}
          close={() => setCodeStep(null)}
          apply={(step) => {
            session.change({
              content: updateStep(snapshot.content, codeStep, step),
              codeView: null,
              mode: 'code',
            });
            setCodeStep(null);
          }}
        />
      ) : null}
      {publishing ? (
        <PublishDialog
          organizationId={organizationId}
          draft={draft}
          validation={current ? validation : undefined}
          tests={publishTests?.({ draft })}
          close={() => setPublishing(false)}
          published={async (result) => {
            await client.invalidateQueries({
              queryKey: workflowsKey(organizationId),
            });
            await navigate({
              to: '/app/$organizationId/workflows/$definitionId',
              params: {
                organizationId,
                definitionId: result.version.definitionId,
              },
            });
          }}
        />
      ) : null}
      <DiscardDialog
        open={discarding}
        organizationId={organizationId}
        draft={draft}
        close={() => setDiscarding(false)}
        discarded={async () => {
          await client.invalidateQueries({
            queryKey: draftsKey(organizationId),
          });
          await navigate({
            to: '/app/$organizationId/workflows',
            params: { organizationId },
          });
        }}
      />
    </>
  );
}

function DiscardDialog({
  open,
  organizationId,
  draft,
  close,
  discarded,
}: {
  open: boolean;
  organizationId: string;
  draft: WorkflowDraft;
  close(): void;
  discarded(): Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  return (
    <Dialog open={open} onOpenChange={(value) => !value && !pending && close()}>
      <DialogContent className="workflow-dialog">
        <DialogTitle>{m.authoring_discard_title()}</DialogTitle>
        <DialogDescription>
          {m.authoring_discard_description()}
        </DialogDescription>
        {error ? (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        ) : null}
        <div className="workflow-dialog-actions">
          <Button variant="outline" disabled={pending} onClick={close}>
            {m.authoring_discard_keep()}
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setError('');
              try {
                await discardDraft(organizationId, draft.id, draft.revision);
                await discarded();
              } catch (failure) {
                setError(workflowError(failure));
              } finally {
                setPending(false);
              }
            }}
          >
            {pending
              ? m.authoring_discard_pending()
              : m.authoring_discard_confirm()}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
