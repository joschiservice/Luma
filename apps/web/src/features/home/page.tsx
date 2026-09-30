import './home.css';

import type {
  HomeModule,
  HomeModuleId,
  OperationsOverview,
} from '@luma/api-contract';
import { homeModuleIds } from '@luma/api-contract';
import { CaseNotice } from '@luma/ui/components/issues/case-investigation';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@luma/ui/components/primitives/dropdown-menu';
import { Select } from '@luma/ui/components/primitives/select';
import {
  WorkspaceDate,
  WorkspaceTimezone,
} from '@luma/ui/components/primitives/workspace-date';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowUp,
  Check,
  GripVertical,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { type ReactNode, useContext, useState } from 'react';

import { sessionOptions } from '../identity/data';
import { useWorkspaceLayout } from '../layout/data';
import { overviewOptions } from '../overview/data';
import { OperationalMetrics } from '../overview/operational-metrics';
import { OrderMetrics } from '../overview/order-metrics';
import {
  ActivityModule,
  AttentionModule,
  CatalogModule,
  ConnectionsModule,
  HandlingModule,
  OutcomesModule,
} from './modules';
import {
  defaultHome,
  homeModules,
  type HomeWindow,
  moveModule,
  placeModule,
} from './preferences';

/** Explains setup or data-quality problems that affect everything on Home. */
function setupNotice(data: OperationsOverview) {
  if (!data.connections.length)
    return {
      title: 'Connect your first system.',
      tone: 'info' as const,
      description:
        'Start with Shopify or JTL-Wawi. Once Luma receives observations, issues and outcomes appear here.',
    };
  const monitored = data.connections.filter((c) => c.status !== 'disconnected');
  if (!monitored.length)
    return {
      title: 'No connected systems.',
      tone: 'warning' as const,
      description:
        'Your previous connections are disconnected. Connect a system to monitor operations again.',
    };
  if (monitored.some((c) => c.status !== 'active'))
    return {
      title: 'Check your connections.',
      tone: 'warning' as const,
      description:
        'Some systems are not active. Review their status before relying on what Home shows.',
    };
  if (monitored.some((c) => c.freshness === 'unobserved'))
    return {
      title: 'Waiting for observations.',
      tone: 'info' as const,
      description:
        'At least one system hasn’t sent data for a permitted read yet, so health is still unknown.',
    };
  if (monitored.some((c) => c.freshness === 'stale'))
    return {
      title: 'Your data needs a refresh.',
      tone: 'warning' as const,
      description:
        'Some observations are older than 24 hours. Current operational health is unknown.',
    };

  return null;
}

function greeting(timeZone: string, name?: string) {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(new Date()),
  );
  const part = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';
  const first = name?.trim().split(/\s+/)[0];

  return `Good ${part}${first ? `, ${first}` : ''}`;
}

function ModuleFrame({
  module,
  editing,
  index,
  count,
  bare,
  dragging,
  onMove,
  onResize,
  onRemove,
  onDragStart,
  onDrop,
  onDragEnd,
  children,
}: {
  module: HomeModule;
  editing: boolean;
  index: number;
  count: number;
  bare?: boolean;
  dragging: boolean;
  onMove: (offset: -1 | 1) => void;
  onResize: () => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const info = homeModules[module.id];
  const titleId = `home-module-${module.id}`;
  const controls = editing ? (
    <div
      className="home-module-controls"
      role="group"
      aria-label={`Arrange ${info.title}`}
    >
      <span className="home-module-grip" aria-hidden="true">
        <GripVertical size={15} />
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Move ${info.title} earlier`}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <ArrowUp />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Move ${info.title} later`}
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      >
        <ArrowDown />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={
          module.size === 'full'
            ? `Show ${info.title} at half width`
            : `Show ${info.title} at full width`
        }
        onClick={onResize}
      >
        {module.size === 'full' ? <Minimize2 /> : <Maximize2 />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Remove ${info.title} from Home`}
        onClick={onRemove}
      >
        <X />
      </Button>
    </div>
  ) : null;

  return (
    <section
      className="home-module"
      data-size={module.size}
      data-bare={bare ? 'true' : undefined}
      data-editing={editing ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      data-over={over ? 'true' : undefined}
      aria-labelledby={bare && !editing ? undefined : titleId}
      draggable={editing}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', module.id);
        onDragStart();
      }}
      onDragEnd={() => {
        setOver(false);
        onDragEnd();
      }}
      onDragOver={(event) => {
        if (!editing) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        onDrop();
      }}
    >
      {!bare || editing ? (
        <header className="home-module-header">
          <h2 id={titleId}>
            <info.Icon size={15} aria-hidden="true" />
            {info.title}
          </h2>
          {controls}
        </header>
      ) : null}
      <div className="home-module-body" inert={editing ? true : undefined}>
        {children}
      </div>
    </section>
  );
}

/**
 * Renders the workspace Home: what needs the reader's attention and what Luma is
 * handling, arranged from modules the reader can add, remove, reorder and resize.
 */
export function HomePage() {
  const { organizationId } = useParams({ from: '/app/$organizationId/home' });
  const { window } = useSearch({ from: '/app/$organizationId/home' });
  const navigate = useNavigate({ from: '/app/$organizationId/home' });
  const timeZone = useContext(WorkspaceTimezone);
  const client = useQueryClient();
  const session = client.getQueryData(sessionOptions().queryKey);
  const overview = useQuery(overviewOptions(organizationId, window));
  const workspace = useWorkspaceLayout(organizationId);
  const [editing, setEditing] = useState(false);
  const [dragged, setDragged] = useState<HomeModuleId | null>(null);
  const modules = workspace.layout?.home ?? defaultHome;
  const hidden = homeModuleIds.filter(
    (id) => !modules.some((module) => module.id === id),
  );
  const data =
    overview.isError || overview.isPaused ? undefined : overview.data;
  const notice = data ? setupNotice(data) : null;
  const update = (next: HomeModule[]) => workspace.save({ home: next });
  const today = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date());

  function content(module: HomeModule) {
    switch (module.id) {
      case 'operational-metrics':
        return (
          <OperationalMetrics
            key={`summary-${organizationId}`}
            organizationId={organizationId}
          />
        );
      case 'order-metrics':
        return (
          <OrderMetrics key={organizationId} organizationId={organizationId} />
        );
      case 'activity':
        return <ActivityModule organizationId={organizationId} />;
      case 'catalog':
        return <CatalogModule organizationId={organizationId} />;
    }
    if (!data)
      return (
        <div className="home-skeleton" aria-hidden="true">
          <span className="lu-skeleton" />
          <span className="lu-skeleton" />
          <span className="lu-skeleton" />
        </div>
      );
    switch (module.id) {
      case 'attention':
        return (
          <AttentionModule organizationId={organizationId} overview={data} />
        );
      case 'handling':
        return (
          <HandlingModule organizationId={organizationId} overview={data} />
        );
      case 'connections':
        return (
          <ConnectionsModule organizationId={organizationId} overview={data} />
        );
      case 'outcomes':
        return <OutcomesModule overview={data} />;
    }
  }

  return (
    <div className="home">
      <header className="home-header">
        <div className="home-header-copy">
          <p className="home-date">{today}</p>
          <h1>{greeting(timeZone, session?.user.name)}</h1>
          <p className="home-lead">
            {data
              ? data.attentionCount
                ? `${data.attentionCount} ${data.attentionCount === 1 ? 'decision needs' : 'decisions need'} you. Luma is handling the rest.`
                : 'Nothing needs your decision right now. Here’s what Luma is handling.'
              : 'Here’s what needs you and what Luma is handling.'}
          </p>
          {data ? (
            <p className="home-asof">
              Updated <WorkspaceDate value={data.generatedAt} /> · refreshes
              every 30 seconds
            </p>
          ) : null}
        </div>
        <div className="home-header-actions">
          <Select<HomeWindow>
            aria-label="Resolution window"
            className="home-window"
            value={window}
            onValueChange={(value) => {
              if (value) void navigate({ search: { window: value } });
            }}
            options={[
              { value: '24h', label: 'Last 24 hours' },
              { value: '7d', label: 'Last 7 days' },
            ]}
          />
          <Button
            variant="outline"
            onClick={() => void overview.refetch()}
            disabled={overview.isFetching || overview.isPaused}
          >
            <RefreshCw
              aria-hidden="true"
              className={overview.isFetching ? 'home-spin' : undefined}
            />
            {overview.isError ? 'Retry' : 'Refresh'}
          </Button>
          <Button
            variant={editing ? 'default' : 'outline'}
            aria-pressed={editing}
            onClick={() => setEditing(!editing)}
            disabled={!workspace.layout}
          >
            {editing ? (
              <Check aria-hidden="true" />
            ) : (
              <SlidersHorizontal aria-hidden="true" />
            )}
            {editing ? 'Done' : 'Customize'}
          </Button>
        </div>
      </header>

      {overview.isPaused ? (
        <CaseNotice title="Updates paused while offline">
          Current health and totals are unavailable. Reconnect to refresh Home
          automatically.
        </CaseNotice>
      ) : overview.isError ? (
        <CaseNotice error title="Operations overview unavailable">
          Current health and totals could not be confirmed. Retry to load
          authoritative data.
        </CaseNotice>
      ) : notice ? (
        <Alert
          tone={notice.tone}
          role="region"
          aria-label="Operational health"
          className="home-notice"
        >
          <h2>{notice.title}</h2>
          <p>{notice.description}</p>
          <Link to="/app/$organizationId/apps" params={{ organizationId }}>
            Manage connections
          </Link>
        </Alert>
      ) : null}

      {editing ? (
        <div
          className="home-customize"
          role="region"
          aria-label="Customize Home"
        >
          <p>
            <strong>Customize your Home.</strong> Drag modules or use the arrows
            to reorder them. Changes save automatically and only affect you.
          </p>
          <div className="home-customize-actions">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" disabled={!hidden.length} />}
              >
                <Plus aria-hidden="true" />
                Add module
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="home-module-menu">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Available modules</DropdownMenuLabel>
                  {hidden.map((id) => {
                    const info = homeModules[id];

                    return (
                      <DropdownMenuItem
                        key={id}
                        onClick={() =>
                          update([...modules, { id, size: info.size }])
                        }
                      >
                        <info.Icon aria-hidden="true" />
                        <span className="home-module-option">
                          <strong>{info.title}</strong>
                          <span>{info.description}</span>
                        </span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              onClick={() => workspace.save({ home: null })}
              disabled={workspace.layout?.home === null}
            >
              <RotateCcw aria-hidden="true" />
              Reset to default
            </Button>
          </div>
        </div>
      ) : null}

      {workspace.conflict ? (
        <Alert tone="warning" role="status" className="home-notice">
          Your Home changed in another session. We loaded the latest version.
        </Alert>
      ) : workspace.saveFailed ? (
        <Alert tone="danger" role="alert" className="home-notice">
          Your last change couldn’t be saved. Check your connection and try
          again.
        </Alert>
      ) : null}

      {modules.length ? (
        <div className="home-grid">
          {modules.map((module, index) => (
            <ModuleFrame
              key={module.id}
              module={module}
              editing={editing}
              index={index}
              count={modules.length}
              bare={
                module.id === 'operational-metrics' ||
                module.id === 'order-metrics'
              }
              dragging={dragged === module.id}
              onMove={(offset) =>
                update(moveModule(modules, module.id, offset))
              }
              onResize={() =>
                update(
                  modules.map((item) =>
                    item.id === module.id
                      ? {
                          ...item,
                          size: item.size === 'full' ? 'half' : 'full',
                        }
                      : item,
                  ),
                )
              }
              onRemove={() =>
                update(modules.filter((item) => item.id !== module.id))
              }
              onDragStart={() => setDragged(module.id)}
              onDragEnd={() => setDragged(null)}
              onDrop={() => {
                if (dragged) update(placeModule(modules, dragged, module.id));
                setDragged(null);
              }}
            >
              {content(module)}
            </ModuleFrame>
          ))}
        </div>
      ) : (
        <div className="home-blank">
          <strong>Your Home is empty.</strong>
          <p>Add modules to see what needs you and what Luma is handling.</p>
          <Button variant="outline" onClick={() => setEditing(true)}>
            <SlidersHorizontal aria-hidden="true" />
            Customize
          </Button>
        </div>
      )}
    </div>
  );
}
