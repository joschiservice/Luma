import type { staffWorkspaceHealthSchema } from '@luma/api-contract/staff';
import { Alert, AlertDescription } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { z } from 'zod';

import { errorMessage } from './api';
import { Failure, Loading } from './feedback';
import { healthOptions } from './queries';

type Health = z.infer<typeof staffWorkspaceHealthSchema>;

type Count = { count: number; capped: boolean };

const shown = 20;

/** Formats a server timestamp in the reader's locale, or names a missing one. */
export function formatTime(value: string | null, missing = 'Not recorded') {
  return value ? new Date(value).toLocaleString() : missing;
}

/** Turns a stored code such as `connection_inactive` into readable text. */
export function codeLabel(code: string) {
  const text = code.replaceAll(/[_.-]+/g, ' ').trim();

  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Names a person from workspace records; unknown and former members stay identifiable. */
export function personLabel(person: {
  id: string;
  name: string | null;
  member: boolean | null;
}) {
  if (!person.name) return `Unknown person (${person.id.slice(0, 8)})`;

  return person.member === false
    ? `${person.name} (former member)`
    : person.name;
}

function countLabel(value: Count) {
  return value.capped ? `${value.count}+` : String(value.count);
}

function Truncated({ show, noun }: { show: boolean; noun: string }) {
  return show ? (
    <Alert tone="warning">
      <AlertDescription>
        Only the {shown} most recent {noun} are shown. This list is incomplete.
      </AlertDescription>
    </Alert>
  ) : null;
}

function Group({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="staff-health-group" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  );
}

/** A compact empty state: nested health lists are often empty and stay one line tall. */
function None({ title, children }: { title: string; children: string }) {
  return (
    <p className="staff-health-empty">
      <strong>{title}.</strong> {children}
    </p>
  );
}

function streamStatus(stream: Health['sync']['streams'][number]) {
  if (stream.paused) return <Badge tone="warning">Paused</Badge>;
  if (stream.blocked)
    return <Badge tone="danger">Blocked: {codeLabel(stream.blocked)}</Badge>;
  if (stream.failingSince) return <Badge tone="danger">Failing</Badge>;

  return <Badge tone="success">No current error</Badge>;
}

/**
 * Shows workspace health under the support grant: what needs attention, what is stuck and
 * recent operational evidence. Reads refresh once a minute and keep the last result visible,
 * labeled as possibly out of date, when a refresh fails.
 */
export function WorkspaceHealth({
  workspaceId,
  grantId,
}: {
  workspaceId: string;
  grantId: string;
}) {
  const health = useQuery(healthOptions(workspaceId, grantId));

  return (
    <section
      className="staff-section"
      aria-labelledby="workspace-health"
      aria-busy={health.isFetching}
    >
      <div className="staff-section-header">
        <h2 id="workspace-health">Health</h2>
        {health.data ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void health.refetch()}
          >
            Refresh health
          </Button>
        ) : null}
      </div>
      {health.isPending ? (
        <Loading>Reading workspace health…</Loading>
      ) : !health.data ? (
        <Failure error={health.error} retry={() => void health.refetch()} />
      ) : (
        <HealthDetails
          health={health.data}
          stale={health.isError ? errorMessage(health.error) : null}
        />
      )}
    </section>
  );
}

function HealthDetails({
  health,
  stale,
}: {
  health: Health;
  stale: string | null;
}) {
  const connections = new Map(
    health.connections.items.map((item) => [item.id, item.provider]),
  );
  const connection = (id: string | null) =>
    id ? `${connections.get(id) ?? 'Connection'} · ${id.slice(0, 8)}` : '—';
  const attention = health.sync.streams.filter(
    (stream) => stream.paused || stream.blocked || stream.failingSince,
  ).length;

  return (
    <>
      <p className="staff-muted">
        Read {formatTime(health.readAt)}. Codes and counts only; provider
        payloads and customer records are not shown.
      </p>
      {stale ? (
        <Alert tone="warning" role="alert">
          <AlertDescription>
            The latest refresh failed: {stale} Showing the read from{' '}
            {formatTime(health.readAt)}, which may be out of date.
          </AlertDescription>
        </Alert>
      ) : null}
      <dl className="staff-facts" aria-label="Needs attention">
        <div>
          <dt>Sync streams failing, blocked or paused</dt>
          <dd>
            {attention}
            {health.sync.streamsTruncated ? '+' : ''}
          </dd>
        </div>
        <div>
          <dt>Actions with unknown outcome</dt>
          <dd>{countLabel(health.execution.unknown)}</dd>
        </div>
        <div>
          <dt>Failed actions</dt>
          <dd>{countLabel(health.execution.failed)}</dd>
        </div>
        <div>
          <dt>Workflow steps needing review</dt>
          <dd>
            {health.workflows.steps.length}
            {health.workflows.stepsTruncated ? '+' : ''}
          </dd>
        </div>
        <div>
          <dt>Cases awaiting approval</dt>
          <dd>{health.cases.awaitingApproval}</dd>
        </div>
        <div>
          <dt>Cases needing review</dt>
          <dd>{health.cases.reviewRequired}</dd>
        </div>
        <div>
          <dt>Failed emails</dt>
          <dd>{countLabel(health.mail.failed)}</dd>
        </div>
      </dl>
      <Group id="health-sync" title="Sync">
        <Truncated show={health.sync.streamsTruncated} noun="sync streams" />
        <DataTable
          caption="Sync streams"
          density="compact"
          rows={health.sync.streams}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'stream',
              header: 'Stream',
              cell: (row) => (
                <div>
                  {codeLabel(row.recordType)}
                  <p className="staff-muted">
                    {connection(row.connectionId)} · {codeLabel(row.phase)}
                    {row.scan ? ` · ${codeLabel(row.scan)} scan` : ''}
                  </p>
                </div>
              ),
            },
            { key: 'status', header: 'Status', cell: streamStatus },
            {
              key: 'error',
              header: 'Latest error',
              cell: (row) =>
                row.errorCode ? (
                  <div>
                    <code>{row.errorCode}</code>
                    {row.errorMessage ? (
                      <p className="staff-muted">{row.errorMessage}</p>
                    ) : null}
                    <p className="staff-muted">
                      {row.attempts} failed{' '}
                      {row.attempts === 1 ? 'attempt' : 'attempts'}
                      {row.failingSince
                        ? ` since ${formatTime(row.failingSince)}`
                        : ''}
                    </p>
                  </div>
                ) : (
                  'None'
                ),
            },
            {
              key: 'success',
              header: 'Last success',
              hideOnNarrow: true,
              cell: (row) => formatTime(row.lastSuccessAt, 'Never'),
            },
          ]}
          empty={
            <None title="No sync streams">
              This workspace has no import streams.
            </None>
          }
        />
        <h4>Recent sync runs</h4>
        <Truncated show={health.sync.runsTruncated} noun="sync runs" />
        <DataTable
          caption="Recent sync runs"
          density="compact"
          rows={health.sync.runs}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'started',
              header: 'Started',
              cell: (row) => formatTime(row.startedAt),
            },
            {
              key: 'run',
              header: 'Run',
              cell: (row) =>
                `${codeLabel(row.recordType)} · ${codeLabel(row.kind)} · ${codeLabel(row.trigger)}`,
            },
            {
              key: 'outcome',
              header: 'Outcome',
              cell: (row) => codeLabel(row.outcome),
            },
            {
              key: 'records',
              header: 'Records',
              numeric: true,
              hideOnNarrow: true,
              cell: (row) => row.records,
            },
            {
              key: 'failed',
              header: 'Failed records',
              numeric: true,
              cell: (row) => row.failed,
            },
            {
              key: 'errors',
              header: 'Errors',
              numeric: true,
              cell: (row) => row.errors,
            },
          ]}
          empty={<None title="No sync runs">No sync has run yet.</None>}
        />
      </Group>
      <Group id="health-connections" title="Connections">
        <Truncated
          show={health.connections.itemsTruncated}
          noun="connections"
        />
        <DataTable
          caption="Connection versions"
          density="compact"
          rows={health.connections.items}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'connection',
              header: 'Connection',
              cell: (row) => connection(row.id),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (row) => codeLabel(row.status),
            },
            {
              key: 'version',
              header: 'Version',
              numeric: true,
              cell: (row) => row.version,
            },
            {
              key: 'credentials',
              header: 'Credential version',
              numeric: true,
              cell: (row) => row.credentialVersion ?? '—',
            },
          ]}
          empty={
            <None title="No connections">
              This workspace has no provider connections.
            </None>
          }
        />
        <h4>Latest read checks</h4>
        <Truncated
          show={health.connections.readChecksTruncated}
          noun="read checks"
        />
        <DataTable
          caption="Latest read check per connection capability"
          density="compact"
          rows={health.connections.readChecks}
          rowKey={(row) => `${row.connectionId}:${row.capability}`}
          columns={[
            {
              key: 'capability',
              header: 'Capability',
              cell: (row) => (
                <div>
                  <code>{row.capability}</code>
                  <p className="staff-muted">{connection(row.connectionId)}</p>
                </div>
              ),
            },
            {
              key: 'result',
              header: 'Result',
              cell: (row) =>
                row.succeeded ? (
                  <Badge tone="success">Succeeded</Badge>
                ) : (
                  <Badge tone="danger">
                    Failed{row.errorCode ? `: ${codeLabel(row.errorCode)}` : ''}
                  </Badge>
                ),
            },
            {
              key: 'observed',
              header: 'Checked',
              cell: (row) => formatTime(row.observedAt),
            },
          ]}
          empty={
            <None title="No read checks">
              No connection read has been recorded.
            </None>
          }
        />
        <h4>Recent connection changes</h4>
        <Truncated
          show={health.connections.eventsTruncated}
          noun="connection changes"
        />
        <DataTable
          caption="Recent connection changes"
          density="compact"
          rows={health.connections.events}
          rowKey={(row) => `${row.connectionId}:${row.version}`}
          columns={[
            {
              key: 'when',
              header: 'When',
              cell: (row) => formatTime(row.createdAt),
            },
            {
              key: 'event',
              header: 'Change',
              cell: (row) => (
                <div>
                  {codeLabel(row.event)} → {codeLabel(row.status)}
                  <p className="staff-muted">{connection(row.connectionId)}</p>
                </div>
              ),
            },
            {
              key: 'credentials',
              header: 'Credential version',
              numeric: true,
              hideOnNarrow: true,
              cell: (row) => row.credentialVersion,
            },
            {
              key: 'actor',
              header: 'By',
              cell: (row) => personLabel(row.actor),
            },
          ]}
          empty={
            <None title="No connection changes">
              No connection lifecycle change has been recorded.
            </None>
          }
        />
      </Group>
      <Group id="health-execution" title="Actions">
        <p className="staff-muted">
          Actions with an unknown outcome may or may not have changed the
          provider. Verification decides; a retry must not repeat them.
        </p>
        <Truncated
          show={health.execution.actionsTruncated}
          noun="unknown or failed actions"
        />
        <DataTable
          caption="Actions with an unknown outcome or failure"
          density="compact"
          rows={health.execution.actions}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'updated',
              header: 'Updated',
              cell: (row) => formatTime(row.updatedAt),
            },
            {
              key: 'capability',
              header: 'Action',
              cell: (row) => (
                <div>
                  <code>{row.capability ?? 'Unknown capability'}</code>
                  <p className="staff-muted">{connection(row.connectionId)}</p>
                </div>
              ),
            },
            {
              key: 'state',
              header: 'State',
              cell: (row) =>
                row.state === 'unknown' ? (
                  <Badge tone="warning">Outcome unknown</Badge>
                ) : (
                  <Badge tone="danger">Failed</Badge>
                ),
            },
            {
              key: 'dispatch',
              header: 'Dispatch',
              hideOnNarrow: true,
              cell: (row) =>
                row.dispatch ? codeLabel(row.dispatch) : 'Not recorded',
            },
          ]}
          empty={
            <None title="No unknown or failed actions">
              Every recorded action finished or is still in progress.
            </None>
          }
        />
        <h4>Recent action failures</h4>
        <Truncated
          show={health.execution.failuresTruncated}
          noun="action failures"
        />
        <DataTable
          caption="Recent action failures"
          density="compact"
          rows={health.execution.failures}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'when',
              header: 'When',
              cell: (row) => formatTime(row.createdAt),
            },
            {
              key: 'code',
              header: 'Failure',
              cell: (row) => (
                <div>
                  <code>{row.code ?? 'unknown'}</code>
                  <p className="staff-muted">
                    {row.phase ? `${codeLabel(row.phase)} phase` : ''}
                  </p>
                </div>
              ),
            },
            {
              key: 'effect',
              header: 'Provider effect',
              cell: (row) =>
                row.effect === 'unknown'
                  ? 'Unknown'
                  : row.effect === 'none'
                    ? 'None'
                    : 'Not recorded',
            },
            {
              key: 'retry',
              header: 'Retry',
              hideOnNarrow: true,
              cell: (row) => (row.retry ? codeLabel(row.retry) : '—'),
            },
          ]}
          empty={
            <None title="No action failures">
              No action failure has been recorded.
            </None>
          }
        />
      </Group>
      <Group id="health-workflows" title="Workflows">
        <p>
          Runs awaiting admission with no recorded step:{' '}
          <strong>{countLabel(health.workflows.awaitingAdmission)}</strong>
          {health.workflows.awaitingAdmission.oldestTriggeredAt
            ? `, oldest triggered ${formatTime(health.workflows.awaitingAdmission.oldestTriggeredAt)}`
            : ''}
        </p>
        <Truncated
          show={health.workflows.stepsTruncated}
          noun="workflow steps"
        />
        <DataTable
          caption="Workflow steps that failed, were inconclusive, escalated or waited more than a day"
          density="compact"
          rows={health.workflows.steps}
          rowKey={(row) => `${row.runId}:${row.stepId}`}
          columns={[
            {
              key: 'workflow',
              header: 'Workflow',
              cell: (row) => (
                <div>
                  <code>{row.definitionId}</code>
                  <p className="staff-muted">Run {row.runId.slice(0, 8)}</p>
                </div>
              ),
            },
            {
              key: 'step',
              header: 'Step',
              cell: (row) =>
                `${row.stepId}${row.kind ? ` (${codeLabel(row.kind)})` : ''}`,
            },
            {
              key: 'state',
              header: 'State',
              cell: (row) => (
                <Badge tone={row.state === 'waiting' ? 'warning' : 'danger'}>
                  {row.state === 'waiting'
                    ? 'Waiting over a day'
                    : codeLabel(row.state)}
                </Badge>
              ),
            },
            {
              key: 'recorded',
              header: 'Recorded',
              hideOnNarrow: true,
              cell: (row) => formatTime(row.recordedAt),
            },
          ]}
          empty={
            <None title="No workflow steps need review">
              No run ended without success or has waited more than a day.
            </None>
          }
        />
        <h4>Active case workflows</h4>
        <Truncated
          show={health.workflows.activationsTruncated}
          noun="case workflow activations"
        />
        <DataTable
          caption="Active case workflow activations"
          density="compact"
          rows={health.workflows.activations}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'workflow',
              header: 'Workflow',
              cell: (row) => <code>{row.definitionId}</code>,
            },
            {
              key: 'principal',
              header: 'Acts as',
              cell: (row) => personLabel(row.principal),
            },
            {
              key: 'since',
              header: 'Active since',
              hideOnNarrow: true,
              cell: (row) => formatTime(row.createdAt),
            },
          ]}
          empty={
            <None title="No active case workflows">
              No workflow acts on new cases in this workspace.
            </None>
          }
        />
      </Group>
      <Group id="health-cases" title="Cases and approvals">
        <dl className="staff-facts staff-facts-compact">
          <div>
            <dt>Open cases</dt>
            <dd>{health.cases.open}</dd>
          </div>
          {health.cases.byState.map((row) => (
            <div key={row.state}>
              <dt>{codeLabel(row.state)}</dt>
              <dd>{row.count}</dd>
            </div>
          ))}
        </dl>
      </Group>
      <Group id="health-other" title="Mail, apps and settings">
        <Truncated show={health.mail.itemsTruncated} noun="failed emails" />
        <DataTable
          caption="Failed workspace emails"
          density="compact"
          rows={health.mail.items}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'created',
              header: 'Created',
              cell: (row) => formatTime(row.createdAt),
            },
            {
              key: 'kind',
              header: 'Email',
              cell: (row) => codeLabel(row.kind),
            },
            {
              key: 'attempts',
              header: 'Attempts',
              numeric: true,
              cell: (row) => row.attempts,
            },
          ]}
          empty={
            <None title="No failed emails">
              Every workspace email was sent, queued or cancelled.
            </None>
          }
        />
        <Truncated show={health.appsTruncated} noun="apps" />
        <DataTable
          caption="Workspace apps"
          density="compact"
          rows={health.apps}
          rowKey={(row) => row.appId}
          columns={[
            { key: 'app', header: 'App', cell: (row) => row.appId },
            {
              key: 'status',
              header: 'Status',
              cell: (row) => codeLabel(row.status),
            },
            {
              key: 'version',
              header: 'Installation version',
              numeric: true,
              cell: (row) => row.version,
            },
            {
              key: 'release',
              header: 'App version',
              hideOnNarrow: true,
              cell: (row) => row.appVersion ?? 'Not recorded',
            },
          ]}
          empty={<None title="No apps">No app has been installed.</None>}
        />
        <dl className="staff-facts staff-facts-compact">
          <div>
            <dt>Time zone</dt>
            <dd>{health.settings?.timezone ?? 'UTC (default)'}</dd>
          </div>
          <div>
            <dt>Approval policy</dt>
            <dd>
              {health.settings?.alwaysRequireApproval
                ? 'Approval always required'
                : 'Approval follows the workspace policy'}
            </dd>
          </div>
        </dl>
      </Group>
    </>
  );
}
