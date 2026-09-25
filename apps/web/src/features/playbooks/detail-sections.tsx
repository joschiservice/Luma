import type {
  PlaybookActivationView,
  PlaybookDetail,
  PlaybookVersionView,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Card, CardTitle } from '@luma/ui/components/primitives/card';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Empty } from '@luma/ui/components/primitives/empty';
import { Link } from '@tanstack/react-router';
import { ShieldCheck } from 'lucide-react';

import { systemNames } from './library';

/** Summarizes the selected version, approval requirements, and currently active versions. */
export function PlaybookOverview({
  detail,
  version,
}: {
  detail: PlaybookDetail;
  version: PlaybookVersionView;
}) {
  return (
    <Card className="playbook-section">
      <CardTitle>Overview</CardTitle>
      <dl className="playbook-facts">
        <div>
          <dt>Systems</dt>
          <dd>
            {version.systems
              .map((system) => systemNames[system] ?? system)
              .join(' · ') || 'Unsupported'}
          </dd>
        </div>
        <div>
          <dt>Issue type</dt>
          <dd>{version.issueType.replaceAll('_', ' ')}</dd>
        </div>
        <div>
          <dt>Approval</dt>
          <dd>{version.approval}</dd>
        </div>
        <div>
          <dt>Active versions</dt>
          <dd>{detail.summary.activeVersions.join(', ') || 'None'}</dd>
        </div>
      </dl>
      <p className="playbook-caption">
        Activating a new version does not replace existing activations.
      </p>
    </Card>
  );
}

/** Explains the selected version as an ordered correction and verification flow. */
export function PlaybookSteps({ version }: { version: PlaybookVersionView }) {
  return (
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
  );
}

/** Shows version and connection prerequisites with links to resolve connection access. */
export function PlaybookCompatibility({
  detail,
  version,
  organizationId,
}: {
  detail: PlaybookDetail;
  version: PlaybookVersionView;
  organizationId: string;
}) {
  return (
    <Card as="section" className="playbook-section">
      <CardTitle as="h2">
        <ShieldCheck size={18} aria-hidden="true" /> Compatibility and
        permissions
      </CardTitle>
      <p>Review connection access before activating this version.</p>
      <Disclosure>
        <summary>Required permissions</summary>
        <ul>
          {version.permissions.map((permission) => (
            <li key={permission}>
              <code>{permission}</code>
            </li>
          ))}
        </ul>
      </Disclosure>
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
      <Link to="/app/$organizationId/connections" params={{ organizationId }}>
        Manage connections
      </Link>
    </Card>
  );
}

/** Lists granted scopes and offers revocation only for active grants the viewer may manage. */
export function PlaybookActivations({
  detail,
  refreshing,
  onRevoke,
}: {
  detail: PlaybookDetail;
  refreshing?: boolean | undefined;
  onRevoke: (activation: PlaybookActivationView) => void;
}) {
  return (
    <Card as="section" className="playbook-section">
      <CardTitle as="h2">Activation history</CardTitle>
      <p>
        Revoking an activation stops future runs. Work already dispatched may
        still complete.
      </p>
      {!detail.activations.length ? (
        <Empty className="playbook-section-empty">
          <ShieldCheck size={22} aria-hidden="true" />
          <h3>Not activated yet</h3>
          <p>
            Review a version and choose its scope to permit this playbook to
            run.
          </p>
        </Empty>
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
                  onClick={() => onRevoke(a)}
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
            <p>
              Orders:{' '}
              {a.grants.targetIds
                .map(
                  (id) =>
                    detail.connections
                      .flatMap((connection) => connection.targets)
                      .find((target) => target.id === id)?.label ?? id,
                )
                .join(', ')}
            </p>

            <Disclosure>
              <summary>Exact scope and review</summary>
              <p>Orders: {a.grants.targetIds.join(', ')}</p>
              <p>Principals: {a.grants.principalIds.join(', ')}</p>
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
  );
}

/** Keeps published version provenance and exact artifacts available for inspection. */
export function PlaybookVersions({ detail }: { detail: PlaybookDetail }) {
  return (
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
  );
}
