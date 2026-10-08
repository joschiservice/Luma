import type {
  WorkflowActivationView,
  WorkflowDetail,
  WorkflowVersionView,
} from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
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
    return version.finalOutcome ?? m.workflows_overview_success_handoff();

  return version.capability === 'orders.shipping-method.write'
    ? m.workflows_overview_success_shipping()
    : m.workflows_overview_success_default();
}

const versionSources = {
  pilot: m.workflows_versions_source_pilot,
  resolution: m.workflows_versions_source_resolution,
  native: m.workflows_versions_source_native,
} satisfies Record<WorkflowVersionView['provenance']['kind'], () => string>;

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
    <section
      className="workflow-overview"
      aria-label={m.workflows_overview_label()}
    >
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
            <Zap size={14} aria-hidden="true" /> {m.workflows_overview_when()}
          </span>
          <strong>{workflowTriggerLabel(version.applicability.trigger)}</strong>
          <p>{m.workflows_overview_when_help()}</p>
        </div>
        <ArrowRight
          className="workflow-contract-arrow"
          size={18}
          aria-hidden="true"
        />
        <div>
          <span className="workflow-contract-label">
            <ShieldCheck size={14} aria-hidden="true" />{' '}
            {m.workflows_overview_success()}
          </span>
          <strong>{successDefinition(version)}</strong>
          <p>{m.workflows_overview_success_help()}</p>
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
          {m.workflows_overview_steps_title()}
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
          {m.workflows_overview_versions_caption()}
        </p>
      </Card>
    </section>
  );
}

/** Keeps action references, permissions, inputs and published versions inspectable. */
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
        <CardTitle as="h2">{m.workflows_technical_title()}</CardTitle>
        <p className="workflow-caption">
          {m.workflows_technical_caption({ version: version.version })}
        </p>
        <Disclosure>
          <summary>{m.workflows_technical_steps()}</summary>
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
          <summary>{m.workflows_technical_requirements()}</summary>
          <WorkflowCompatibility
            detail={detail}
            version={version}
            organizationId={organizationId}
          />
        </Disclosure>
        <Disclosure>
          <summary>{m.workflows_technical_inputs()}</summary>
          <dl className="workflow-facts">
            <div>
              <dt>{m.workflows_technical_applies_to()}</dt>
              <dd>
                <code>{version.applicability.subjectKind}</code>
              </dd>
            </div>
            {Object.entries(version.inputs).map(([name, type]) => (
              <div key={name}>
                <dt>{name.replace(/([a-z])([A-Z])/g, '$1 $2')}</dt>
                <dd>{m.workflows_technical_input_type({ type })}</dd>
              </div>
            ))}
            {Object.entries(version.context.fields).map(([name, type]) => (
              <div key={name}>
                <dt>{name.replace(/([a-z])([A-Z])/g, '$1 $2')}</dt>
                <dd>{m.workflows_technical_data_type({ type })}</dd>
              </div>
            ))}
          </dl>
          <p className="workflow-caption">
            {m.workflows_technical_max_age({
              seconds: version.context.maxAgeSeconds,
            })}
          </p>
        </Disclosure>
        <Disclosure>
          <summary>{m.workflows_technical_versions()}</summary>
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
    return <p>{m.workflows_technical_computation()}</p>;
  if (detail.presentation === 'procurement.replenishment')
    return (
      <>
        <p>{m.workflows_technical_replenishment()}</p>
        {version.blockers.map((reason) => (
          <Alert key={reason}>{reason}</Alert>
        ))}
      </>
    );

  return (
    <>
      <p>{m.workflows_technical_permissions()}</p>
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
        <p>{m.workflows_technical_no_connections()}</p>
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
              {m.workflows_technical_connection_status({
                system: workflowSystemLabel(c.system),
                status: c.blockers.length
                  ? m.workflows_technical_connection_missing()
                  : m.workflows_technical_connection_ready(),
              })}
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
        <CardTitle as="h2">{m.workflows_activations_title()}</CardTitle>
        {action}
      </div>
      <p>{m.workflows_activations_description()}</p>
      {!detail.activations.length ? (
        <Empty className="workflow-section-empty">
          <ShieldCheck size={22} aria-hidden="true" />
          <h3>
            {processOnly
              ? m.workflows_activations_empty_process_title()
              : m.workflows_activations_empty_title()}
          </h3>
          <p>
            {processOnly
              ? m.workflows_activations_empty_process_body()
              : m.workflows_activations_empty_body()}
          </p>
        </Empty>
      ) : (
        detail.activations.map((a) => (
          <article key={a.id} className="workflow-activation-record">
            <div className="workflows-heading">
              <h3>
                {a.active
                  ? m.workflows_activations_active({ version: a.version })
                  : m.workflows_activations_revoked({ version: a.version })}
              </h3>
              {detail.canManage && a.active ? (
                <Button
                  variant="outline"
                  disabled={refreshing}
                  onClick={() => onRevoke(a)}
                >
                  {m.workflows_activations_revoke()}
                </Button>
              ) : null}
            </div>
            <p>
              {m.workflows_activations_connection({
                connections: formatList(
                  a.grants.connectionIds.map(
                    (id) =>
                      detail.connections.find((c) => c.id === id)?.label ?? id,
                  ),
                ),
              })}
            </p>
            <p>
              {m.workflows_activations_orders({
                orders: formatList(
                  a.grants.targetIds.map(
                    (id) => targets.find((t) => t.id === id)?.label ?? id,
                  ),
                ),
              })}
            </p>
            <Disclosure>
              <summary>{m.workflows_activations_details()}</summary>
              <p>
                {m.workflows_activations_orders({
                  orders: a.grants.targetIds.join(', '),
                })}
              </p>
              <p>
                {m.workflows_activations_people({
                  people: a.grants.principalIds.join(', '),
                })}
              </p>
              <p>{m.workflows_activations_id({ id: a.id })}</p>
              <p>
                {m.workflows_activations_rules_version({
                  version: a.policyVersion,
                })}
              </p>
              <p>
                {a.reviewedBy
                  ? m.workflows_activations_reviewed_by({
                      person: a.reviewedBy,
                    })
                  : m.workflows_activations_reviewed_outside()}
              </p>
              {a.reviewedAt ? (
                <time dateTime={a.reviewedAt}>
                  <WorkspaceDate value={a.reviewedAt} />
                </time>
              ) : null}
              <p>
                {m.workflows_activations_version_fingerprint()}{' '}
                <code>{a.versionDigest}</code>
              </p>
              <p>
                {m.workflows_activations_fingerprint()}{' '}
                <code>{a.artifactDigest}</code>
              </p>
            </Disclosure>
          </article>
        ))
      )}
    </Card>
  );
}

/** Keeps where each published version came from and its exact content available for inspection. */
export function WorkflowVersions({ detail }: { detail: WorkflowDetail }) {
  return (
    <>
      {detail.versions.map((v) => (
        <Disclosure key={v.version}>
          <summary>
            {m.workflows_versions_summary({
              version: v.version,
              source: versionSources[v.provenance.kind](),
              status: v.compatible
                ? m.workflows_versions_compatible()
                : m.workflows_versions_unavailable(),
            })}
          </summary>
          <p>
            {m.workflows_versions_author({ author: v.provenance.authoredBy })}{' '}
            {v.provenance.reference}
          </p>
          <p>
            {m.workflows_versions_sources({
              sources: v.provenance.evidenceRefs.join(', '),
            })}
          </p>
          <code>{v.digest}</code>
          <pre>{v.representation}</pre>
        </Disclosure>
      ))}
    </>
  );
}
