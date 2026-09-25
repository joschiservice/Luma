import type {
  PlaybookActivationView,
  PlaybookDetail,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Select } from '@luma/ui/components/primitives/select';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, BookOpen, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

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
import { type PlaybookFilters, statusNames, systemNames } from './library';
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
      <Link
        className="playbook-back"
        to="/app/$organizationId/playbooks"
        params={{ organizationId }}
        search={filters}
      >
        <ArrowLeft size={15} aria-hidden="true" /> All playbooks
      </Link>
      {query.error || accessError ? (
        <Alert tone="danger" role="alert" className="playbook-notice">
          {playbookError(query.error ?? accessError)}{' '}
          <Button onClick={() => void refresh()} variant="outline">
            Retry
          </Button>
        </Alert>
      ) : null}
      {accessError ? null : query.isPending ? (
        <p role="status">Loading playbook…</p>
      ) : query.data ? (
        <>
          <PlaybookDetailView
            key={query.data.canManage ? 'manage' : 'read'}
            detail={query.data}
            organizationId={organizationId}
            refresh={refresh}
            refreshing={query.isFetching || !!query.error}
            accessLost={accessLost}
          />
          {query.data.canManage ? (
            <ShadowReport
              key={`${organizationId}:${definitionId}`}
              organizationId={organizationId}
              workflow={definitionId}
            />
          ) : null}
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
              Execution acceptance and verified correction are separate results.
              Pilot, simulation and shadow evidence are not live verified
              success.
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
                        params={{ organizationId, exceptionId: run.incidentId }}
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
        </>
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
}: {
  detail: PlaybookDetail;
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
        'Activation revoked. Future admission is blocked; already-dispatched work is not undone.',
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
      <div className="playbooks-heading">
        <div>
          <p className="playbooks-kicker">
            <BookOpen size={15} aria-hidden="true" />{' '}
            {statusNames[detail.summary.status]}
          </p>
          <h1>{detail.summary.name}</h1>
          <p className="desk-intro">{detail.summary.purpose}</p>
        </div>
        <Button
          variant="outline"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          {refreshing ? 'Refreshing…' : 'Refresh playbook'}
        </Button>
      </div>
      <div className="playbook-version-bar">
        <label>
          Version
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
              label: `${v.version}${v.version === detail.summary.availableVersion ? ' — latest published' : ''}`,
            }))}
          />
        </label>
        <span>
          {version.provenance.kind === 'pilot'
            ? 'Pilot provenance'
            : 'Resolution provenance'}
        </span>
        <Button
          disabled={!canActivate || refreshing}
          onClick={() => setActivate(true)}
        >
          Review activation
        </Button>
      </div>
      {!detail.canManage ? (
        <Alert className="playbook-notice">
          You can inspect playbooks. Only workspace owners and admins can
          activate or revoke them.
        </Alert>
      ) : null}
      <p>Publishing a newer version never replaces an active version.</p>
      {message ? <p role="status">{message}</p> : null}
      <div className="playbook-detail-grid">
        <Card
          as="section"
          className="playbook-section"
          aria-labelledby="steps-title"
        >
          <CardTitle as="h2" id="steps-title">
            How this playbook works
          </CardTitle>
          <ol className="playbook-steps">
            {version.steps.map((step, i) => (
              <li key={step.id}>
                <span className="playbook-step-number" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.description}</p>
                  <ul>
                    {step.details.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        </Card>
        <Card as="aside" className="playbook-section">
          <CardTitle as="h2">
            <ShieldCheck size={18} aria-hidden="true" /> Compatibility and
            permissions
          </CardTitle>
          <p>Required: {version.permissions.join(', ')}.</p>
          {version.blockers.map((reason) => (
            <Alert key={reason} className="playbook-notice">
              {reason}
            </Alert>
          ))}
          {!detail.connections.length ? (
            <p>No connections installed.</p>
          ) : (
            detail.connections.map((c) => (
              <article className="playbook-connection" key={c.id}>
                <h3>
                  <Link
                    to="/app/$organizationId/connections"
                    params={{ organizationId }}
                    hash={`connection-${c.id}`}
                  >
                    {c.label}
                  </Link>
                </h3>
                <p>
                  {systemNames[c.system] ?? c.system} ·{' '}
                  {c.blockers.length
                    ? 'Prerequisites missing'
                    : 'Eligible connection'}
                </p>
                {c.blockers.map((reason) => (
                  <p key={reason}>{reason}</p>
                ))}
              </article>
            ))
          )}
          <Link
            to="/app/$organizationId/connections"
            params={{ organizationId }}
          >
            Manage connections
          </Link>
          <CardTitle as="h3">Evaluation evidence</CardTitle>
          <p>
            Shadow comparisons are available below for workspace owners and
            admins. Each prediction retains its exact Playbook version.
          </p>
        </Card>
      </div>
      <Card as="section" className="playbook-section">
        <CardTitle as="h2">Activation history</CardTitle>
        <p>
          Revocation blocks future admission. It preserves the grant and does
          not undo already-dispatched work.
        </p>
        {!detail.activations.length ? (
          <p>No activations. This playbook is not permitted to run.</p>
        ) : (
          detail.activations.map((a) => (
            <article key={a.id} className="playbook-activation-record">
              <div className="playbooks-heading">
                <h3>
                  Version {a.version} · {a.active ? 'Active' : 'Revoked'}
                </h3>
                {detail.canManage && a.active ? (
                  <Button
                    variant="outline"
                    disabled={refreshing}
                    onClick={() => {
                      setRevoke(a);
                      setError('');
                    }}
                  >
                    Revoke activation
                  </Button>
                ) : null}
              </div>
              <p>
                Connections:{' '}
                {a.grants.connectionIds
                  .map(
                    (id) =>
                      detail.connections.find((c) => c.id === id)?.label ?? id,
                  )
                  .join(', ')}
              </p>
              <p>Orders: {a.grants.targetIds.join(', ')}</p>
              <p>Principals: {a.grants.principalIds.join(', ')}</p>
              <Disclosure>
                <summary>Exact scope and review</summary>
                <p>Activation: {a.id}</p>
                <p>Policy: {a.policyVersion}</p>
                <p>
                  Reviewed by:{' '}
                  {a.reviewedBy ??
                    'Trusted provisioning; no product review record'}
                </p>
                {a.reviewedAt ? (
                  <time dateTime={a.reviewedAt}>
                    {new Date(a.reviewedAt).toLocaleString()}
                  </time>
                ) : null}
                <p>
                  Version digest: <code>{a.versionDigest}</code>
                </p>
                <p>
                  Artifact digest: <code>{a.artifactDigest}</code>
                </p>
              </Disclosure>
            </article>
          ))
        )}
      </Card>
      <Card as="section" className="playbook-section">
        <CardTitle as="h2">Provenance and version history</CardTitle>
        {detail.versions.map((v) => (
          <Disclosure key={v.version}>
            <summary>
              Version {v.version} · {v.provenance.kind} ·{' '}
              {v.compatible ? 'Compatible' : 'Unavailable'}
            </summary>
            <p>
              Authored by {v.provenance.authoredBy}. {v.provenance.reference}
            </p>
            <p>Evidence: {v.provenance.evidenceRefs.join(', ')}</p>
            <code>{v.digest}</code>
            <pre>{v.representation}</pre>
          </Disclosure>
        ))}
      </Card>
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
            Future admission under this artifact will be blocked.
            Already-dispatched work may still complete. This does not undo
            changes. A later activation creates a new record.
          </DialogDescription>
          <p>
            Version {revoke?.version} · {revoke?.grants.targetIds.length} orders
          </p>
          {error ? <p role="alert">{error}</p> : null}
          <Button disabled={pending} onClick={() => void revokeSelected()}>
            {pending ? 'Confirming revocation…' : 'Confirm revocation'}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
