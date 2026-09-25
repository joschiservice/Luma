import type {
  PlaybookActivationView,
  PlaybookDetail,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card, CardHeader } from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Select } from '@luma/ui/components/primitives/select';
import { SectionWorkspace } from '@luma/ui/components/workspace/section-workspace';
import { WorkspaceBreadcrumb } from '@luma/ui/components/workspace/workspace-breadcrumb';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, BookOpen, ChevronRight, RefreshCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { SignInRedirect } from '../identity/common';
import { contextOptions, IdentityError } from '../identity/data';
import { ShadowReport } from '../shadow/report';
import { ActivationForm } from './activation';
import {
  playbookError,
  playbookOptions,
  playbookRunsOptions,
  playbooksKey,
  revokePlaybook,
} from './data';
import {
  PlaybookActivations,
  PlaybookCompatibility,
  PlaybookOverview,
  PlaybookSteps,
  PlaybookVersions,
} from './detail-sections';
import { type PlaybookFilters, PlaybookLoading, statusNames } from './library';
import { OfflineNotice } from './offline';

/** Loads a shareable playbook, resetting private form state when the workspace or playbook changes. */
export function PlaybookPage() {
  const { organizationId, definitionId } = useParams({
    from: '/app/$organizationId/playbooks/$definitionId',
  });
  const filters = useSearch({
    from: '/app/$organizationId/playbooks/$definitionId',
  });

  return (
    <PlaybookDetailPage
      key={`${organizationId}:${definitionId}`}
      organizationId={organizationId}
      definitionId={definitionId}
      filters={filters}
    />
  );
}

/** Reads current playbook controls and history independently and hides private content after access loss. */
export function PlaybookDetailPage({
  organizationId,
  definitionId,
  filters = {},
}: {
  organizationId: string;
  definitionId: string;
  filters?: PlaybookFilters;
}) {
  const query = useQuery(playbookOptions(organizationId, definitionId));
  const runs = useQuery(playbookRunsOptions(organizationId, definitionId));
  const client = useQueryClient();
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: playbooksKey(organizationId) });
  };
  const accessLost = async () => {
    client.removeQueries({ queryKey: playbooksKey(organizationId) });
    await client.invalidateQueries({
      queryKey: contextOptions(organizationId).queryKey,
    });
    await refresh();
  };
  const accessError = [query.error, runs.error].find(
    (e) => e instanceof IdentityError && [401, 403, 404].includes(e.status),
  );
  if (accessError instanceof IdentityError && accessError.status === 401)
    return <SignInRedirect />;

  return (
    <div className="playbooks-page">
      <OfflineNotice />
      {!query.data || accessError ? (
        <Link
          className="playbook-back"
          to="/app/$organizationId/playbooks"
          params={{ organizationId }}
          search={filters}
        >
          <ArrowLeft size={15} aria-hidden="true" /> All playbooks
        </Link>
      ) : null}
      {query.error || accessError ? (
        <Alert tone="danger" role="alert" className="playbook-notice">
          {playbookError(query.error ?? accessError)}{' '}
          <Button onClick={() => void refresh()} variant="outline">
            Retry
          </Button>
        </Alert>
      ) : null}
      {accessError ? null : query.isPending ? (
        <PlaybookLoading detail />
      ) : query.data ? (
        <PlaybookDetailView
          key={query.data.canManage ? 'manage' : 'read'}
          detail={query.data}
          organizationId={organizationId}
          filters={filters}
          refresh={refresh}
          refreshing={query.isFetching || !!query.error}
          accessLost={accessLost}
          evaluation={
            query.data.canManage ? (
              <ShadowReport
                key={`${organizationId}:${definitionId}`}
                organizationId={organizationId}
                workflow={definitionId}
              />
            ) : null
          }
          runs={
            <Card
              as="section"
              className="playbook-section"
              aria-labelledby="runs-title"
            >
              <CardHeader className="playbooks-heading">
                <h2 id="runs-title">Recent runs</h2>
                <Button
                  variant="outline"
                  disabled={runs.isFetching}
                  onClick={() => void runs.refetch()}
                >
                  Refresh runs
                </Button>
              </CardHeader>
              <p>
                Execution acceptance and verified correction are separate
                results. Pilot, simulation and shadow evidence are not live
                verified success.
              </p>
              {runs.error ? (
                <p role="alert">
                  Run history is unavailable. {playbookError(runs.error)}
                </p>
              ) : runs.isPending ? (
                <p role="status">Loading runs…</p>
              ) : !runs.data?.length ? (
                <p>No runs recorded for this playbook.</p>
              ) : (
                <div className="playbook-runs">
                  {runs.data.map((run) => (
                    <article key={run.id}>
                      <div className="playbooks-heading">
                        <Link
                          to="/app/$organizationId/exceptions/$exceptionId"
                          params={{
                            organizationId,
                            exceptionId: run.incidentId,
                          }}
                        >
                          Open issue
                        </Link>
                        <time dateTime={run.createdAt}>
                          {new Date(run.createdAt).toLocaleString()}
                        </time>
                      </div>
                      <p>
                        Version {run.version} ·{' '}
                        <strong>
                          {run.evidenceKind === 'pilot'
                            ? 'Pilot evidence'
                            : run.evidenceKind === 'unclassified'
                              ? 'Unclassified evidence — live success not established'
                              : `${run.evidenceKind} evidence`}
                        </strong>
                      </p>
                      <dl>
                        <div>
                          <dt>Execution</dt>
                          <dd>{run.execution.replaceAll('_', ' ')}</dd>
                        </div>
                        <div>
                          <dt>Verification</dt>
                          <dd>{run.verification.replaceAll('_', ' ')}</dd>
                        </div>
                      </dl>
                      <p>{run.reason.replaceAll('_', ' ')}</p>
                      <Disclosure>
                        <summary>Run evidence references</summary>
                        <p>Run: {run.id}</p>
                        <p>Activation: {run.activationId}</p>
                        <code>{run.versionDigest}</code>
                      </Disclosure>
                    </article>
                  ))}
                </div>
              )}
            </Card>
          }
        />
      ) : null}
    </div>
  );
}

/** Presents readable steps, version history, prerequisites and exact activation grants. */
export function PlaybookDetailView({
  detail,
  organizationId,
  refresh,
  refreshing,
  accessLost,
  filters = {},
  evaluation,
  runs,
}: {
  detail: PlaybookDetail;
  filters?: PlaybookFilters;
  evaluation?: ReactNode;
  runs?: ReactNode;
  organizationId: string;
  refresh: () => Promise<void>;
  refreshing?: boolean;
  accessLost: () => Promise<void>;
}) {
  const [selected, setSelected] = useState(detail.versions[0]!.version);
  const [activate, setActivate] = useState(false);
  const [revoke, setRevoke] = useState<PlaybookActivationView | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const version =
    detail.versions.find((v) => v.version === selected) ?? detail.versions[0]!;
  const canActivate =
    detail.canManage &&
    version.compatible &&
    detail.connections.some((c) => !c.blockers.length);
  const done = async () => {
    setActivate(false);
    setMessage(
      'Activation saved. This exact version and scope are now permitted.',
    );
    await refresh();
  };
  const revokeSelected = async () => {
    if (!revoke || pending) return;
    setPending(true);
    setError('');
    try {
      await revokePlaybook(
        organizationId,
        detail.summary.id,
        revoke.id,
        revoke.artifactDigest,
      );
      setRevoke(null);
      setMessage(
        'Activation revoked. Future runs are blocked; work already dispatched may still complete.',
      );
      await refresh();
    } catch (error) {
      setError(playbookError(error));
      if (error instanceof IdentityError && [401, 403].includes(error.status))
        await accessLost();
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <WorkspaceBreadcrumb>
        <BookOpen size={16} aria-hidden="true" />
        <Link
          to="/app/$organizationId/playbooks"
          params={{ organizationId }}
          search={filters}
        >
          Playbooks
        </Link>
        <ChevronRight size={14} aria-hidden="true" />
        <span aria-current="page" title={detail.summary.name}>
          {detail.summary.name}
        </span>
      </WorkspaceBreadcrumb>
      <h1 className="sr-only">{detail.summary.name}</h1>
      <div className="playbook-action-bar">
        <Link
          className="playbook-back"
          to="/app/$organizationId/playbooks"
          params={{ organizationId }}
          search={filters}
        >
          <ArrowLeft size={15} aria-hidden="true" /> All playbooks
        </Link>
        <Badge
          tone={
            detail.summary.status === 'active'
              ? 'success'
              : detail.summary.status === 'unavailable'
                ? 'warning'
                : 'neutral'
          }
        >
          {statusNames[detail.summary.status]}
        </Badge>
        <Button
          variant="ghost"
          aria-label="Refresh playbook"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </Button>
        <div className="playbook-version-controls">
          <Select
            aria-label="Version"
            value={version.version}
            onValueChange={(value) => {
              if (value === null) return;
              setSelected(value);
              setActivate(false);
            }}
            options={detail.versions.map((v) => ({
              value: v.version,
              label: `v${v.version}${v.version === detail.summary.availableVersion ? ' · Latest' : ''}`,
            }))}
          />
          <Button
            disabled={!canActivate || refreshing}
            aria-describedby={
              !canActivate ? 'playbook-activation-reason' : undefined
            }
            onClick={() => setActivate(true)}
          >
            Review activation
          </Button>
        </div>
      </div>
      {!canActivate ? (
        <Alert
          id="playbook-activation-reason"
          tone={detail.canManage ? 'warning' : 'neutral'}
          className="playbook-notice"
        >
          {!detail.canManage
            ? 'You can inspect playbooks. Only workspace owners and admins can activate or revoke them.'
            : !version.compatible
              ? 'This version cannot be activated. Review the compatibility requirements below.'
              : 'No eligible connections. Resolve the connection requirements below before activating.'}
        </Alert>
      ) : null}
      {message ? (
        <Alert tone="success" role="status" className="playbook-notice">
          {message}
        </Alert>
      ) : null}
      <SectionWorkspace
        label="Playbook sections"
        sections={[
          {
            value: 'overview',
            label: 'Overview',
            content: <PlaybookOverview detail={detail} version={version} />,
          },
          {
            value: 'steps',
            label: 'How it works',
            content: <PlaybookSteps version={version} />,
          },
          {
            value: 'compatibility',
            label: 'Compatibility',
            content: (
              <PlaybookCompatibility
                detail={detail}
                version={version}
                organizationId={organizationId}
              />
            ),
          },
          {
            value: 'activations',
            label: 'Activations',
            content: (
              <PlaybookActivations
                detail={detail}
                refreshing={refreshing}
                onRevoke={(activation) => {
                  setRevoke(activation);
                  setError('');
                }}
              />
            ),
          },
          ...(runs
            ? [{ value: 'runs', label: 'Recent runs', content: runs }]
            : []),
          ...(evaluation
            ? [
                {
                  value: 'evaluation',
                  label: 'Evaluation',
                  content: evaluation,
                },
              ]
            : []),
          {
            value: 'versions',
            label: 'Version history',
            content: <PlaybookVersions detail={detail} />,
          },
        ]}
      />
      <Dialog open={activate && detail.canManage} onOpenChange={setActivate}>
        <DialogContent className="playbook-dialog">
          <DialogTitle>Review activation</DialogTitle>
          <DialogDescription>
            Confirm the exact version, connection, orders and approval behavior
            before granting access.
          </DialogDescription>
          <ActivationForm
            key={`${selected}:${activate}`}
            organizationId={organizationId}
            detail={detail}
            version={version.version}
            done={done}
            cancel={() => setActivate(false)}
            accessLost={accessLost}
          />
        </DialogContent>
      </Dialog>
      <Dialog
        open={revoke !== null && detail.canManage}
        onOpenChange={(open) => {
          if (!open && !pending) setRevoke(null);
        }}
      >
        <DialogContent className="playbook-dialog">
          <DialogTitle>Revoke activation?</DialogTitle>
          <DialogDescription>
            This stops future runs under this activation. Work already
            dispatched may still complete. Existing changes are not undone.
          </DialogDescription>
          <p>
            Version {revoke?.version} · {revoke?.grants.targetIds.length} orders
          </p>
          {error ? <p role="alert">{error}</p> : null}
          <div className="playbook-dialog-actions">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setRevoke(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => void revokeSelected()}
            >
              {pending ? 'Confirming revocation…' : 'Confirm revocation'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
