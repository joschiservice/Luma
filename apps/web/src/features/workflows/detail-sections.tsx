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
import type { ReactNode } from 'react';

import {
  workflowCategoryLabel,
  workflowSystemLabel,
  workflowTriggerLabel,
} from './presentation';
import { WorkflowReadinessPanel } from './readiness';

/** States what success means for a version in operator language. */
function successDefinition(version: WorkflowVersionView) {
  if (version.format === 'workflow/2')
    return version.finalOutcome ?? 'The process hands the run to a person';

  return version.capability === 'orders.shipping-method.write'
    ? 'The order uses the mapped shipping method'
    : 'The expected change is verified';
}

/**
 * Puts purpose, trigger, success and readiness first, followed by the steps in business
 * language. Technical identifiers live in Technical details.
 */
export function WorkflowOverview({
  detail,
  version,
  organizationId,
}: {
  detail: WorkflowDetail;
  version: WorkflowVersionView;
  organizationId: string;
}) {
  return (
    <section className="workflow-overview" aria-label="Workflow overview">
      <div className="workflow-intent">
        <p className="workflow-eyebrow">
          {workflowCategoryLabel(version.category)}
        </p>
        <h2>{detail.summary.name}</h2>
        <p>{detail.summary.purpose}</p>
      </div>
      <div className="workflow-contract-flow">
        <div>
          <span className="workflow-contract-label">
            <Zap size={14} aria-hidden="true" /> When
          </span>
          <strong>{workflowTriggerLabel(version.applicability.trigger)}</strong>
          <p>Luma checks fresh evidence before proposing a change.</p>
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
          <strong>{successDefinition(version)}</strong>
          <p>
            An independent read confirms the result. A successful request alone
            doesn’t count.
          </p>
        </div>
      </div>
      <WorkflowReadinessPanel
        organizationId={organizationId}
        definitionId={detail.summary.id}
        readiness={detail.summary.readiness}
      />
      <Card
        as="section"
        className="workflow-section"
        aria-labelledby="steps-title"
      >
        <CardTitle as="h2" id="steps-title">
          How it works
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
              </div>
            </li>
          ))}
        </ol>
        <p className="workflow-caption">
          Each published version is fixed. Selecting another version changes
          this view only.
        </p>
      </Card>
    </section>
  );
}

/** Keeps capability IDs, permissions, inputs and version artifacts inspectable. */
export function WorkflowTechnical({
  detail,
  version,
  organizationId,
  code,
}: {
  detail: WorkflowDetail;
  version: WorkflowVersionView;
  organizationId: string;
  /** Code Step controls for versions that contain them. */
  code?: ReactNode;
}) {
  return (
    <div className="workflow-technical">
      <Card as="section" className="workflow-section">
        <CardTitle as="h2">Technical details</CardTitle>
        <p className="workflow-caption">
          Exact identifiers behind version {version.version}. You don’t need
          them to run this workflow.
        </p>
        <Disclosure>
          <summary>Steps and capabilities</summary>
          <ol className="workflow-steps">
            {version.steps.map((step, i) => (
              <li key={step.id}>
                <span className="workflow-step-number" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div>
                  <strong className="workflow-technical-step">
                    {step.title}
                  </strong>
                  {step.reference ? <code>{step.reference}</code> : null}
                  <ul>
                    {step.details.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ol>
        </Disclosure>
        <Disclosure>
          <summary>Compatibility and permissions</summary>
          <WorkflowCompatibility
            detail={detail}
            version={version}
            organizationId={organizationId}
          />
        </Disclosure>
        <Disclosure>
          <summary>Inputs and evidence</summary>
          <dl className="workflow-facts">
            <div>
              <dt>Applies to</dt>
              <dd>
                <code>{version.applicability.subjectKind}</code>
              </dd>
            </div>
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
            old. Each run keeps the exact inputs it used.
          </p>
        </Disclosure>
        <Disclosure>
          <summary>Version history and artifacts</summary>
          <WorkflowVersions detail={detail} />
        </Disclosure>
      </Card>
      {code}
    </div>
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
  if (
    version.format === 'workflow/2' &&
    version.executionMode === 'computation'
  )
    return (
      <p>
        People who can manage workflow triggers start this version from Rules.
        It computes values from the supplied evidence and doesn’t need
        connection access or action grants.
      </p>
    );
  if (detail.presentation === 'procurement.replenishment')
    return (
      <>
        <p>
          Each rule covers one stock position and supplier. Stock must be less
          than five minutes old, and someone else who can approve changes
          approves every purchase-order draft.
        </p>
        {version.blockers.map((reason) => (
          <Alert key={reason}>{reason}</Alert>
        ))}
      </>
    );

  return (
    <>
      <p>Required permissions on the connection:</p>
      <ul>
        {version.permissions.map((permission) => (
          <li key={permission}>
            <code>{permission}</code>
          </li>
        ))}
      </ul>
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
                to="/app/$organizationId/apps"
                params={{ organizationId }}
                hash={`connection-${c.id}`}
              >
                {c.label}
              </Link>
            </h3>
            <p>
              {workflowSystemLabel(c.system)} ·{' '}
              {c.blockers.length ? 'Access missing' : 'Eligible connection'}
            </p>
            {c.blockers.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
          </article>
        ))
      )}
    </>
  );
}

/** Lists granted scopes and offers revocation only for active grants the viewer may manage. */
export function WorkflowActivations({
  detail,
  refreshing,
  onRevoke,
  action,
}: {
  detail: WorkflowDetail;
  refreshing?: boolean | undefined;
  onRevoke: (activation: WorkflowActivationView) => void;
  /** The control that reviews a new activation. */
  action?: ReactNode;
}) {
  const processOnly = detail.versions.every(
    (version) => version.format === 'workflow/2',
  );
  const targets = detail.connections.flatMap(
    (connection) => connection.targets,
  );

  return (
    <Card as="section" className="workflow-section">
      <div className="workflows-heading">
        <CardTitle as="h2">Activations</CardTitle>
        {action}
      </div>
      <p>
        An activation lets one exact version act on the orders it names.
        Revoking it stops future runs; work already dispatched may still
        complete.
      </p>
      {!detail.activations.length ? (
        <Empty className="workflow-section-empty">
          <ShieldCheck size={22} aria-hidden="true" />
          <h3>{processOnly ? 'No action grants' : 'Not activated yet'}</h3>
          <p>
            {processOnly
              ? 'Each action needs its own decision and access check before it runs.'
              : 'Review a version and choose its orders to let this workflow run.'}
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
              Connection:{' '}
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
                .map((id) => targets.find((t) => t.id === id)?.label ?? id)
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
    <>
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
    </>
  );
}
