import type {
  WorkflowActivationView,
  WorkflowDetail,
  WorkflowVersionView,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Card, CardTitle } from '@luma/ui/components/primitives/card';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Empty } from '@luma/ui/components/primitives/empty';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Link } from '@tanstack/react-router';
import { ArrowRight, ShieldCheck, Zap } from 'lucide-react';

import { workflowSystemLabel, workflowTriggerLabel } from './presentation';

/** Summarizes the selected version, approval requirements, and currently active versions. */
export function WorkflowOverview({
  detail,
  version,
}: {
  detail: WorkflowDetail;
  version: WorkflowVersionView;
}) {
  const trigger = version.applicability.trigger;
  const triggerLabel = workflowTriggerLabel(trigger);

  return (
    <section className="workflow-overview" aria-label="Workflow overview">
      <div className="workflow-intent">
        <p className="workflow-eyebrow">
          {version.category === 'resolution'
            ? 'Resolution workflow'
            : version.category}
        </p>
        <h2>{detail.summary.name}</h2>
        <p>{detail.summary.purpose}</p>
      </div>
      <div className="workflow-contract-flow">
        <div>
          <span className="workflow-contract-label">
            <Zap size={14} aria-hidden="true" /> When
          </span>
          <strong>{triggerLabel}</strong>
          <p>Check fresh evidence before proposing a change.</p>
        </div>
        <ArrowRight
          className="workflow-contract-arrow"
          size={18}
          aria-hidden="true"
        />
        <div>
          <span className="workflow-contract-label">
            <ShieldCheck size={14} aria-hidden="true" /> Success means
          </span>
          <strong>
            {version.format === 'workflow/2'
              ? (version.finalOutcome ?? 'The process escalates for review')
              : version.capability === 'orders.shipping-method.write'
                ? 'The order uses the mapped shipping method'
                : 'The expected change is verified'}
          </strong>
          <p>
            {version.format === 'workflow/2'
              ? 'Each action is reviewed and admitted independently. Verification failures remain visible for operator review.'
              : `Read the authoritative ${version.applicability.subjectKind}. Escalate if the result cannot be confirmed.`}
          </p>
        </div>
      </div>
      <dl className="workflow-facts">
        <div>
          <dt>Applies to</dt>
          <dd>{version.applicability.subjectKind}</dd>
        </div>
        <div>
          <dt>Connected systems</dt>
          <dd>
            {version.systems.map(workflowSystemLabel).join(' · ') ||
              'None available'}
          </dd>
        </div>
        <div>
          <dt>Selected version</dt>
          <dd>v{version.version}</dd>
        </div>
        <div>
          <dt>Active versions</dt>
          <dd>{detail.summary.activeVersions.join(', ') || 'None'}</dd>
        </div>
      </dl>
      <p className="workflow-caption">
        Each published version is fixed. Selecting a version only changes this
        view.{' '}
        {version.format === 'workflow/2'
          ? 'Each action needs the required connection and access before it can run.'
          : 'An activation permits that exact version to run within its reviewed scope.'}
      </p>
      <div className="workflow-approval-note">
        <ShieldCheck size={17} aria-hidden="true" />
        <p>{version.approval}</p>
      </div>
      <Disclosure>
        <summary>Inputs and evidence</summary>
        <dl className="workflow-facts">
          {Object.entries(version.inputs).map(([name, type]) => (
            <div key={name}>
              <dt>{name.replace(/([a-z])([A-Z])/g, '$1 $2')}</dt>
              <dd>{type} · required input</dd>
            </div>
          ))}
          {Object.entries(version.context.fields).map(([name, type]) => (
            <div key={name}>
              <dt>{name.replace(/([a-z])([A-Z])/g, '$1 $2')}</dt>
              <dd>{type} · observed evidence</dd>
            </div>
          ))}
        </dl>
        <p className="workflow-caption">
          Evidence must be less than {version.context.maxAgeSeconds} seconds
          old. Each run retains the exact inputs used.
        </p>
      </Disclosure>
    </section>
  );
}

/** Explains the selected version as an ordered correction and verification flow. */
export function WorkflowSteps({ version }: { version: WorkflowVersionView }) {
  return (
    <Card
      as="section"
      className="workflow-section"
      aria-labelledby="steps-title"
    >
      <CardTitle as="h2" id="steps-title">
        How this workflow works
      </CardTitle>
      <ol className="workflow-steps">
        {version.steps.map((step, i) => (
          <li key={step.id}>
            <span className="workflow-step-number" aria-hidden="true">
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
export function WorkflowCompatibility({
  detail,
  version,
  organizationId,
}: {
  detail: WorkflowDetail;
  version: WorkflowVersionView;
  organizationId: string;
}) {
  return (
    <Card as="section" className="workflow-section">
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
        <Alert key={reason} className="workflow-notice">
          {reason}
        </Alert>
      ))}
      {!detail.connections.length ? (
        <p>No connections installed.</p>
      ) : (
        detail.connections.map((c) => (
          <article className="workflow-connection" key={c.id}>
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
              {c.system} ·{' '}
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
export function WorkflowActivations({
  detail,
  refreshing,
  onRevoke,
}: {
  detail: WorkflowDetail;
  refreshing?: boolean | undefined;
  onRevoke: (activation: WorkflowActivationView) => void;
}) {
  const processOnly = detail.versions.every(
    (version) => version.format === 'workflow/2',
  );

  return (
    <Card as="section" className="workflow-section">
      <CardTitle as="h2">Activation history</CardTitle>
      <p>
        Revoking an activation stops future runs. Work already dispatched may
        still complete.
      </p>
      {!detail.activations.length ? (
        <Empty className="workflow-section-empty">
          <ShieldCheck size={22} aria-hidden="true" />
          <h3>{processOnly ? 'No action grants' : 'Not activated yet'}</h3>
          <p>
            {processOnly
              ? 'Each action needs its own decision and access check before it runs.'
              : 'Review a version and choose its scope to permit this workflow to run.'}
          </p>
        </Empty>
      ) : (
        detail.activations.map((a) => (
          <article key={a.id} className="workflow-activation-record">
            <div className="workflows-heading">
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
                  <WorkspaceDate value={a.reviewedAt} />
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
export function WorkflowVersions({ detail }: { detail: WorkflowDetail }) {
  return (
    <Card as="section" className="workflow-section">
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
