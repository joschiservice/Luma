import './authoring.css';

import type { WorkflowTemplate } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Input } from '@luma/ui/components/primitives/input';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { WorkspaceBreadcrumb } from '@luma/ui/components/workspace/workspace-breadcrumb';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  Check,
  ChevronRight,
  Code2,
  LayoutList,
  MessageSquareText,
  Search,
  TriangleAlert,
  Workflow,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { SignInRedirect } from '../../identity/common';
import { contextOptions, IdentityError } from '../../identity/data';
import { workflowError } from '../data';
import { OfflineNotice } from '../offline';
import { createDraft, draftsKey, templatesOptions } from './data';
import { DescribeDialog } from './describe';
import { UseTemplateDialog } from './use-template';

const categories = {
  procurement: 'Procurement',
  resolution: 'Resolution',
  inventory: 'Inventory',
} as const;

export interface GallerySearch {
  category?: keyof typeof categories | undefined;
  q?: string | undefined;
}

/** Validates shareable gallery filters and drops unsupported values. */
export function parseGallerySearch(
  value: Record<string, unknown>,
): GallerySearch {
  return {
    category:
      typeof value.category === 'string' &&
      Object.hasOwn(categories, value.category)
        ? (value.category as GallerySearch['category'])
        : undefined,
    q: typeof value.q === 'string' ? value.q.slice(0, 200) : '',
  };
}

/** A way to start a custom workflow from scratch. */
export type ScratchMode = 'language' | 'visual' | 'code';

/** Lists templates and ways to start a custom workflow in the active workspace. */
export function NewWorkflowPage({
  describe,
}: {
  describe?: (props: { close(): void }) => ReactNode;
}) {
  const { organizationId } = useParams({ from: '/app/$organizationId' });
  const search = useSearch({ from: '/app/$organizationId/workflows/new' });
  const navigate = useNavigate();
  const client = useQueryClient();
  const templates = useQuery(templatesOptions(organizationId));
  const context = useQuery(contextOptions(organizationId));
  const [request, setRequest] = useState<
    Parameters<typeof createDraft>[1] | null
  >(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  if (
    templates.error instanceof IdentityError &&
    templates.error.status === 401
  )
    return <SignInRedirect />;

  async function start(body: Parameters<typeof createDraft>[1]) {
    setRequest(body);
    setPending(true);
    setError('');
    try {
      const draft = await createDraft(organizationId, body);
      setRequest(null);
      await client.invalidateQueries({ queryKey: draftsKey(organizationId) });
      await navigate({
        to: '/app/$organizationId/workflows/drafts/$draftId',
        params: { organizationId, draftId: draft.id },
        search: { view: body.mode === 'code' ? 'code' : 'build' },
      });
    } catch (failure) {
      setError(workflowError(failure));
      if (failure instanceof IdentityError && failure.status < 500)
        setRequest(null);
    } finally {
      setPending(false);
    }
  }

  return (
    <NewWorkflowView
      organizationId={organizationId}
      templates={templates.data}
      loading={templates.isPending}
      error={templates.error ? workflowError(templates.error) : undefined}
      retry={() => void templates.refetch()}
      canManage={!!context.data && context.data.actor.role !== 'member'}
      search={search}
      changeSearch={(next) =>
        void navigate({
          to: '/app/$organizationId/workflows/new',
          params: { organizationId },
          search: next,
          replace: true,
        })
      }
      pending={pending}
      startError={error}
      retryStart={request ? () => void start(request) : undefined}
      customize={(template) =>
        void start({
          id: crypto.randomUUID(),
          mode: 'template',
          start: { kind: 'template', templateId: template.id },
        })
      }
      scratch={(mode) =>
        void start({
          id: crypto.randomUUID(),
          mode,
          start: { kind: 'blank' },
        })
      }
      describe={
        describe ??
        (({ close }) => (
          <DescribeDialog organizationId={organizationId} close={close} />
        ))
      }
      refresh={() =>
        void client.invalidateQueries({
          queryKey: templatesOptions(organizationId).queryKey,
        })
      }
    />
  );
}

/** Presents template cards, requirements and custom starting points with every loading state. */
export function NewWorkflowView({
  organizationId,
  templates,
  loading,
  error,
  retry,
  canManage,
  search,
  changeSearch,
  pending = false,
  startError,
  retryStart,
  customize,
  scratch,
  describe,
  refresh,
}: {
  organizationId: string;
  templates?: WorkflowTemplate[] | undefined;
  loading?: boolean | undefined;
  error?: string | undefined;
  retry(): void;
  canManage: boolean;
  search: GallerySearch;
  changeSearch(next: GallerySearch): void;
  pending?: boolean | undefined;
  startError?: string | undefined;
  retryStart?: (() => void) | undefined;
  customize(template: WorkflowTemplate): void;
  scratch(mode: Exclude<ScratchMode, 'language'>): void;
  describe?: ((props: { close(): void }) => ReactNode) | undefined;
  refresh(): void;
}) {
  const [using, setUsing] = useState<WorkflowTemplate | null>(null);
  const [describing, setDescribing] = useState(false);
  const text = (search.q ?? '').trim().toLowerCase();
  const matching = templates?.filter((template) =>
    [template.name, template.purpose, template.trigger, ...template.steps]
      .join(' ')
      .toLowerCase()
      .includes(text),
  );
  const shown = matching?.filter(
    (template) => !search.category || template.category === search.category,
  );

  return (
    <div className="workflows-page authoring-page">
      <WorkspaceBreadcrumb>
        <Workflow size={16} aria-hidden="true" />
        <Link to="/app/$organizationId/workflows" params={{ organizationId }}>
          Workflows
        </Link>
        <ChevronRight size={14} aria-hidden="true" />
        <span aria-current="page">New workflow</span>
      </WorkspaceBreadcrumb>
      <PageHeader
        icon={<DomainIcon domain="workflows" size="lg" />}
        title="New workflow"
        description="Start from a template or build your own. Nothing runs until an owner or admin publishes and activates it."
      />
      <OfflineNotice />
      {!canManage ? (
        <Alert tone="neutral" className="workflow-notice">
          You can browse templates. Only workspace owners and admins can set
          them up or create workflows.
        </Alert>
      ) : null}
      {startError ? (
        <Alert tone="danger" role="alert" className="workflow-notice">
          <span>{startError}</span>
          {retryStart ? (
            <Button variant="outline" disabled={pending} onClick={retryStart}>
              Retry
            </Button>
          ) : null}
        </Alert>
      ) : null}
      <section className="authoring-section" aria-labelledby="templates-title">
        <div className="authoring-section-heading">
          <div>
            <h2 id="templates-title">Templates</h2>
            <p>
              Reviewed workflows you configure and activate. Each one lists what
              it needs first.
            </p>
          </div>
        </div>
        <div className="authoring-filters">
          <div
            className="authoring-categories"
            role="group"
            aria-label="Template category"
          >
            {[['', 'All'], ...Object.entries(categories)].map(
              ([value, label]) => (
                <Button
                  key={value}
                  variant="ghost"
                  aria-pressed={(search.category ?? '') === value}
                  onClick={() =>
                    changeSearch({
                      ...search,
                      category: (value ||
                        undefined) as GallerySearch['category'],
                    })
                  }
                >
                  {label}
                  <span className="workflow-view-count">
                    {matching
                      ? value
                        ? matching.filter((item) => item.category === value)
                            .length
                        : matching.length
                      : '—'}
                  </span>
                </Button>
              ),
            )}
          </div>
          <div className="workflow-search">
            <Search size={16} aria-hidden="true" />
            <Input
              type="search"
              aria-label="Search templates"
              placeholder="Search by name or what it does…"
              value={search.q ?? ''}
              onChange={(event) =>
                changeSearch({ ...search, q: event.target.value })
              }
            />
          </div>
        </div>
        {error ? (
          <Alert tone="danger" role="alert">
            <span>Templates are unavailable. {error}</span>
            <Button variant="outline" onClick={retry}>
              Retry
            </Button>
          </Alert>
        ) : loading ? (
          <div className="authoring-template-grid" aria-busy="true">
            <p role="status">Loading templates…</p>
            {[0, 1].map((item) => (
              <div key={item} className="authoring-skeleton" />
            ))}
          </div>
        ) : !templates?.length ? (
          <Empty>
            <Workflow size={26} aria-hidden="true" />
            <h3>No templates installed</h3>
            <p>
              Start from scratch below, or install an app that adds templates.
            </p>
          </Empty>
        ) : !shown?.length ? (
          <Empty>
            <Search size={24} aria-hidden="true" />
            <h3>No matching templates</h3>
            <p>Try another category or search, or start from scratch.</p>
            <Button variant="outline" onClick={() => changeSearch({})}>
              Clear filters
            </Button>
          </Empty>
        ) : (
          <ul className="authoring-template-grid" aria-label="Templates">
            {shown.map((template) => (
              <li key={template.id}>
                <TemplateCard
                  organizationId={organizationId}
                  template={template}
                  canManage={canManage}
                  pending={pending}
                  use={() => setUsing(template)}
                  customize={() => customize(template)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="authoring-section" aria-labelledby="scratch-title">
        <div className="authoring-section-heading">
          <div>
            <h2 id="scratch-title">Start from scratch</h2>
            <p>
              Every way of building produces the same workflow. Switch between
              them at any time.
            </p>
          </div>
        </div>
        <ul className="authoring-scratch" aria-label="Ways to start">
          {describe ? (
            <li>
              <ScratchCard
                icon={<MessageSquareText size={20} aria-hidden="true" />}
                title="Describe it"
                description="Say what should happen in your own words. Luma drafts the steps and lists its assumptions for you to review."
                action="Describe a workflow"
                disabled={!canManage || pending}
                onSelect={() => setDescribing(true)}
              />
            </li>
          ) : null}
          <li>
            <ScratchCard
              icon={<LayoutList size={20} aria-hidden="true" />}
              title="Build visually"
              description="Add steps one by one: read data, check conditions, take actions, ask for approval and check results."
              action="Build a workflow"
              disabled={!canManage || pending}
              onSelect={() => scratch('visual')}
            />
          </li>
          <li>
            <ScratchCard
              icon={<Code2 size={20} aria-hidden="true" />}
              title="Write code"
              description="Edit the whole workflow as TypeScript and write sandboxed Code Steps for calculations."
              action="Write a workflow"
              disabled={!canManage || pending}
              onSelect={() => scratch('code')}
            />
          </li>
        </ul>
      </section>
      {using ? (
        <UseTemplateDialog
          key={using.id}
          organizationId={organizationId}
          template={using}
          close={() => {
            setUsing(null);
            refresh();
          }}
        />
      ) : null}
      {describing && describe
        ? describe({ close: () => setDescribing(false) })
        : null}
    </div>
  );
}

function ScratchCard({
  icon,
  title,
  description,
  action,
  disabled,
  onSelect,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action: string;
  disabled: boolean;
  onSelect(): void;
}) {
  return (
    <Card as="article" className="authoring-scratch-card">
      <span className="authoring-scratch-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      <Button variant="outline" disabled={disabled} onClick={onSelect}>
        {action}
      </Button>
    </Card>
  );
}

/** Shows what a template does, what success means and what it still needs here. */
export function TemplateCard({
  organizationId,
  template,
  canManage,
  pending,
  use,
  customize,
}: {
  organizationId: string;
  template: WorkflowTemplate;
  canManage: boolean;
  pending: boolean;
  use(): void;
  customize(): void;
}) {
  const titleId = `template-${template.id}`;
  const missing = template.requirements.filter((item) => !item.met);

  return (
    <Card as="article" className="authoring-template" aria-labelledby={titleId}>
      <header className="authoring-template-header">
        <DomainIcon
          domain={
            template.category === 'resolution' ? 'workflows' : 'procurement'
          }
          size="md"
        />
        <div>
          <p className="workflow-eyebrow">{categories[template.category]}</p>
          <h3 id={titleId}>{template.name}</h3>
        </div>
        <div className="authoring-template-badges">
          {template.status === 'active' ? (
            <Badge tone="success">Active</Badge>
          ) : null}
          <Badge tone={template.readiness === 'ready' ? 'success' : 'warning'}>
            {template.readiness === 'ready' ? 'Ready' : 'Needs setup'}
          </Badge>
        </div>
      </header>
      <p>{template.purpose}</p>
      <dl className="authoring-template-facts">
        <div>
          <dt>Starts</dt>
          <dd>{template.trigger}</dd>
        </div>
        <div>
          <dt>What it does</dt>
          <dd>
            <ol>
              {template.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </dd>
        </div>
        <div>
          <dt>Success means</dt>
          <dd>{template.success}</dd>
        </div>
      </dl>
      <div className="authoring-requirements">
        <h4>What it needs</h4>
        <ul>
          {template.requirements.map((item) => (
            <li key={item.label} data-met={item.met}>
              {item.met ? (
                <Check size={15} aria-label="Done" />
              ) : (
                <TriangleAlert size={15} aria-label="Missing" />
              )}
              <div>
                <strong>{item.label}</strong>
                <span>{item.detail}</span>
                {item.fix ? (
                  <FixLink organizationId={organizationId} fix={item.fix} />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
      <footer className="authoring-template-actions">
        <Button
          disabled={!canManage || pending}
          aria-describedby={missing.length ? `${titleId}-blocked` : undefined}
          onClick={use}
        >
          Use template
        </Button>
        <Button
          variant="outline"
          disabled={!canManage || pending}
          onClick={customize}
        >
          Customize
        </Button>
        {missing.length ? (
          <span id={`${titleId}-blocked`} className="sr-only">
            {missing.length} requirement(s) still missing.
          </span>
        ) : null}
      </footer>
    </Card>
  );
}

function FixLink({
  organizationId,
  fix,
}: {
  organizationId: string;
  fix: NonNullable<WorkflowTemplate['requirements'][number]['fix']>;
}) {
  if (fix.destination === 'procurement')
    return (
      <Link
        to="/app/$organizationId/procurement"
        params={{ organizationId }}
        search={{ view: 'suppliers', q: '', status: '' }}
      >
        {fix.label}
      </Link>
    );
  if (fix.destination === 'connections')
    return (
      <Link
        to="/app/$organizationId/apps"
        params={{ organizationId }}
        search={{}}
      >
        {fix.label}
      </Link>
    );

  return (
    <Link to="/app/$organizationId/workflows" params={{ organizationId }}>
      {fix.label}
    </Link>
  );
}
