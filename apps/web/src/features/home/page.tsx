import './home.css';

import type {
  HomeModule,
  HomeModuleId,
  OperationsOverview,
} from '@luma/api-contract';
import { homeModuleIds } from '@luma/api-contract';
import { formatDate } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
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
import { useSlowRequest } from '@luma/ui/lib/use-slow-request';
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

import { decisionsOptions } from '../decisions/data';
import { sessionOptions } from '../identity/data';
import { useWorkspaceLayout } from '../layout/data';
import { overviewOptions } from '../overview/data';
import { useLiveMetricSummary } from '../overview/metrics-live';
import { OperationalMetrics } from '../overview/operational-metrics';
import { operationalMetricRequest } from '../overview/operational-metrics-data';
import { orderMetricRequest, OrderMetrics } from '../overview/order-metrics';
import {
  ActivityModule,
  AttentionModule,
  CatalogModule,
  ConnectionsModule,
  FulfillmentModule,
  HandlingModule,
  OutcomesModule,
  ReturnsModule,
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
      title: m.home_notice_first_title(),
      tone: 'info' as const,
      description: m.home_notice_first_description(),
    };
  const monitored = data.connections.filter((c) => c.status !== 'disconnected');
  if (!monitored.length)
    return {
      title: m.home_notice_disconnected_title(),
      tone: 'warning' as const,
      description: m.home_notice_disconnected_description(),
    };
  if (monitored.some((c) => c.status !== 'active'))
    return {
      title: m.home_notice_inactive_title(),
      tone: 'warning' as const,
      description: m.home_notice_inactive_description(),
    };
  if (monitored.some((c) => c.freshness === 'unobserved'))
    return {
      title: m.home_notice_waiting_title(),
      tone: 'info' as const,
      description: m.home_notice_waiting_description(),
    };
  if (monitored.some((c) => c.freshness === 'stale'))
    return {
      title: m.home_notice_stale_title(),
      tone: 'warning' as const,
      description: m.home_notice_stale_description({
        hours: data.freshnessThresholdHours,
      }),
    };

  return null;
}

const greetings = {
  morning: {
    plain: m.home_greeting_morning,
    named: m.home_greeting_morning_named,
  },
  afternoon: {
    plain: m.home_greeting_afternoon,
    named: m.home_greeting_afternoon_named,
  },
  evening: {
    plain: m.home_greeting_evening,
    named: m.home_greeting_evening_named,
  },
};

function greeting(timeZone: string, name?: string) {
  // Reads the workspace hour as a number; not displayed.
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(new Date()),
  );
  const part =
    greetings[hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'];
  const first = name?.trim().split(/\s+/)[0];

  return first ? part.named({ name: first }) : part.plain();
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
      aria-label={m.home_module_arrange({ module: info.title })}
    >
      <span className="home-module-grip" aria-hidden="true">
        <GripVertical size={15} />
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={m.home_module_move_up({ module: info.title })}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <ArrowUp />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={m.home_module_move_down({ module: info.title })}
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
            ? m.home_module_half_width({ module: info.title })
            : m.home_module_full_width({ module: info.title })
        }
        onClick={onResize}
      >
        {module.size === 'full' ? <Minimize2 /> : <Maximize2 />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={m.home_module_remove({ module: info.title })}
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
  const slowOverview = useSlowRequest(overview.isFetching);
  const waiting = useQuery({
    ...decisionsOptions(organizationId, {}, 5),
    select: (list) => list.counts.views.all,
  });
  const workspace = useWorkspaceLayout(organizationId);
  const [editing, setEditing] = useState(false);
  const [dragged, setDragged] = useState<HomeModuleId | null>(null);
  const modules = workspace.layout?.home ?? defaultHome;
  const hidden = homeModuleIds.filter(
    (id) => !modules.some((module) => module.id === id),
  );
  // Visible metric modules share one live summary read.
  const live = useLiveMetricSummary(organizationId, {
    operational: hidden.includes('operational-metrics')
      ? undefined
      : operationalMetricRequest,
    orders: hidden.includes('order-metrics') ? undefined : orderMetricRequest,
  });
  const data =
    overview.isError || overview.isPaused ? undefined : overview.data;
  const notice = data ? setupNotice(data) : null;
  const update = (next: HomeModule[]) => workspace.save({ home: next });
  const today = formatDate(new Date(), {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  function content(module: HomeModule) {
    switch (module.id) {
      case 'operational-metrics':
        return (
          <OperationalMetrics
            key={`summary-${organizationId}`}
            organizationId={organizationId}
            live={live.operational}
          />
        );
      case 'order-metrics':
        return (
          <OrderMetrics
            key={organizationId}
            organizationId={organizationId}
            live={live.orders}
          />
        );
      case 'activity':
        return <ActivityModule organizationId={organizationId} />;
      case 'catalog':
        return <CatalogModule organizationId={organizationId} />;
      case 'fulfillment':
        return <FulfillmentModule organizationId={organizationId} />;
      case 'returns':
        return <ReturnsModule organizationId={organizationId} />;
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
        return (
          <OutcomesModule overview={data} organizationId={organizationId} />
        );
    }
  }

  return (
    <div className="home">
      <header className="home-header">
        <div className="home-header-copy">
          <p className="home-date">{today}</p>
          <h1>{greeting(timeZone, session?.user.name)}</h1>
          <p className="home-lead">
            {waiting.data !== undefined
              ? waiting.data
                ? m.home_lead_waiting({ count: waiting.data })
                : m.home_lead_none()
              : m.home_lead_loading()}
          </p>
          {data ? (
            <p className="home-asof">
              {rich(m.home_updated, {
                time: <WorkspaceDate value={data.generatedAt} />,
              })}
            </p>
          ) : null}
        </div>
        <div className="home-header-actions">
          <Select<HomeWindow>
            aria-label={m.home_window_label()}
            className="home-window"
            value={window}
            onValueChange={(value) => {
              if (value) void navigate({ search: { window: value } });
            }}
            options={[
              { value: '24h', label: m.home_window_24h() },
              { value: '7d', label: m.home_window_7d() },
            ]}
          />
          <Button
            variant="outline"
            onClick={() => void overview.refetch()}
            disabled={overview.isPaused}
          >
            <RefreshCw
              aria-hidden="true"
              className={slowOverview ? 'home-spin' : undefined}
            />
            {overview.isError ? m.common_retry() : m.common_refresh()}
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
            {editing ? m.common_done() : m.home_customize()}
          </Button>
        </div>
      </header>

      {overview.isPaused ? (
        <CaseNotice title={m.home_paused_title()}>
          {m.home_paused_description()}
        </CaseNotice>
      ) : overview.isError ? (
        <CaseNotice error title={m.home_failed_title()}>
          {m.home_failed_description()}
        </CaseNotice>
      ) : notice ? (
        <Alert
          tone={notice.tone}
          role="region"
          aria-label={m.home_notice_region()}
          className="home-notice"
        >
          <h2>{notice.title}</h2>
          <p>{notice.description}</p>
          <Link to="/app/$organizationId/apps" params={{ organizationId }}>
            {m.home_notice_manage_connections()}
          </Link>
        </Alert>
      ) : null}

      {editing ? (
        <div
          className="home-customize"
          role="region"
          aria-label={m.home_customize_region()}
        >
          <p>
            <strong>{m.home_customize_title()}</strong>{' '}
            {m.home_customize_description()}
          </p>
          <div className="home-customize-actions">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" disabled={!hidden.length} />}
              >
                <Plus aria-hidden="true" />
                {m.home_customize_add()}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="home-module-menu">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    {m.home_customize_available()}
                  </DropdownMenuLabel>
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
              {m.home_customize_reset()}
            </Button>
          </div>
        </div>
      ) : null}

      {workspace.conflict ? (
        <Alert tone="warning" role="status" className="home-notice">
          {m.home_layout_conflict()}
        </Alert>
      ) : workspace.saveFailed ? (
        <Alert tone="danger" role="alert" className="home-notice">
          {m.common_save_failed()}
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
          <strong>{m.home_blank_title()}</strong>
          <p>{m.home_blank_description()}</p>
          <Button variant="outline" onClick={() => setEditing(true)}>
            <SlidersHorizontal aria-hidden="true" />
            {m.home_customize()}
          </Button>
        </div>
      )}
    </div>
  );
}
