import './settings.css';

import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Disclosure } from '@luma/ui/components/primitives/disclosure';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Spinner } from '@luma/ui/components/primitives/spinner';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';

import { contextOptions } from '../../kit/identity/data';
import { usePermissions } from '../../kit/identity/permissions';
import { useNow } from '../../kit/live/now';
import { createWebApiClient } from '../../lib/api-client';
import { IdentityError } from '../../lib/api-error';
import { privateQueryDefaults } from '../../lib/private-query';
import { useSettingsOnline } from './command';
import { SectionHeading } from './section-heading';

const api = createWebApiClient();
const key = (organizationId: string) =>
  ['private', 'organization', organizationId, 'source-environments'] as const;

type Item = Awaited<
  ReturnType<typeof api.sourceEnvironments.list>
>['items'][number];

type Review = Awaited<ReturnType<typeof api.sourceEnvironments.inspect>>;

type Command = Parameters<typeof api.sourceEnvironments.change>[0]['body'];

function errorMessage(error: unknown) {
  if (error instanceof IdentityError) {
    if (error.status === 409) return m.settings_source_conflict();
    if ([401, 403, 404].includes(error.status))
      return m.settings_autonomy_change_access();
    if ([400, 422].includes(error.status))
      return m.settings_autonomy_change_invalid();
  }

  return m.settings_source_read_failed();
}

function SourceDeclaration({
  organizationId,
  item,
  disabled,
  actorId,
  now,
}: {
  organizationId: string;
  item: Item;
  disabled: boolean;
  actorId: string | undefined;
  now: number;
}) {
  const id = useId();
  const client = useQueryClient();
  const [review, setReview] = useState<Review>();
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [uncertain, setUncertain] = useState<Command>();
  const inFlight = useRef(false);
  const locked = disabled || pending || !!uncertain;
  const reviewCurrent =
    !!review &&
    item.reviewable &&
    review.actorId === actorId &&
    Date.parse(review.expiresAt) > now;
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: key(organizationId) }),
      client.invalidateQueries({
        queryKey: ['private', 'organization', organizationId, 'autonomy'],
      }),
    ]);

  async function inspect() {
    if (locked || !item.reviewable || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    setSaved('');
    setReview(undefined);
    setConfirmed(false);
    try {
      setReview(
        await api.sourceEnvironments.inspect({
          params: { organizationId, connectionId: item.connectionId },
        }),
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  async function send(command: Command) {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    setSaved('');
    try {
      const declaration = await api.sourceEnvironments.change({
        params: { organizationId, connectionId: item.connectionId },
        body: command,
      });
      setUncertain(undefined);
      setReview(undefined);
      setConfirmed(false);
      setReason('');
      setSaved(
        declaration.revoked
          ? m.settings_source_revoked()
          : m.settings_source_saved(),
      );
    } catch (error) {
      if (!(error instanceof IdentityError) || error.status >= 500) {
        // Keep every reviewed input, including the old revision, even if a fresh list finds the saved change.
        setUncertain(command);
        setError(m.settings_source_uncertain());
      } else {
        setUncertain(undefined);
        setError(errorMessage(error));
        if (error.status === 409) {
          setReview(undefined);
          setConfirmed(false);
        }
      }
    } finally {
      inFlight.current = false;
      setPending(false);
      void refresh();
    }
  }

  function change(revoke: boolean) {
    if (locked || !reason.trim() || (!revoke && (!reviewCurrent || !confirmed)))
      return;
    void send({
      commandId: crypto.randomUUID(),
      expectedRevision: item.declaration?.revision ?? 0,
      reviewId: revoke ? null : review!.id,
      liveOperationsConfirmed: !revoke,
      reason: reason.trim(),
    });
  }

  return (
    <article className="settings-panel settings-autonomy-policy">
      <h3>
        {item.label}{' '}
        <Badge>
          {item.environment === 'live'
            ? m.settings_source_live()
            : item.environment === 'synthetic'
              ? m.settings_autonomy_synthetic()
              : m.settings_autonomy_unknown()}
        </Badge>
      </h3>
      {item.declaration ? (
        <p className="settings-note">
          {m.settings_source_revision({ revision: item.declaration.revision })}{' '}
          <WorkspaceDate value={item.declaration.at} />
          {item.declaration.revoked ? ` · ${m.settings_source_revoked()}` : ''}
        </p>
      ) : null}
      {item.declaration ? (
        <p className="settings-note">
          {m.settings_autonomy_reason()}: {item.declaration.reason}
        </p>
      ) : null}
      {item.environment === 'unknown' &&
      item.declaration &&
      !item.declaration.revoked ? (
        <Alert tone="warning">{m.settings_source_binding_changed()}</Alert>
      ) : null}
      {item.environment === 'synthetic' ? (
        <p>{m.settings_source_synthetic()}</p>
      ) : (
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={locked || !item.reviewable}
            onClick={() => void inspect()}
          >
            {m.settings_source_inspect()}
          </Button>
          {item.reviewBlock ? (
            <p className="settings-note">
              {{
                synthetic: m.settings_source_synthetic,
                inactive: m.settings_source_inactive,
                missing_capability: m.settings_source_missing_capability,
                app_unavailable: m.settings_source_app_unavailable,
              }[item.reviewBlock]()}
            </p>
          ) : null}
          {review ? (
            <>
              <p>
                {m.settings_source_evidence()}{' '}
                <WorkspaceDate value={review.observedAt} />.{' '}
                {m.settings_source_expires()}{' '}
                <WorkspaceDate value={review.expiresAt} />.
              </p>
              <Disclosure>
                <summary>{m.settings_source_evidence_details()}</summary>
                <dl className="settings-source-evidence">
                  <dt>{m.settings_source_connection_revision()}</dt>
                  <dd>{formatNumber(review.connectionVersion)}</dd>
                  <dt>{m.settings_source_credential_revision()}</dt>
                  <dd>{formatNumber(review.credentialVersion)}</dd>
                  {review.observations.map((observation) => (
                    <div key={observation.id}>
                      <dt>{m.settings_source_provider()}</dt>
                      <dd>{observation.provider}</dd>
                      <dt>{m.settings_source_resource()}</dt>
                      <dd>{observation.resource}</dd>
                      <dt>{m.settings_source_observed()}</dt>
                      <dd>
                        <WorkspaceDate value={observation.observedAt} />
                      </dd>
                      <dt>{m.settings_source_source_revision()}</dt>
                      <dd>
                        {observation.sourceRevision ?? m.common_not_reported()}
                      </dd>
                    </div>
                  ))}
                </dl>
              </Disclosure>
              {!reviewCurrent ? (
                <Alert tone="warning">
                  {m.settings_source_review_expired()}
                </Alert>
              ) : null}
              <Field>
                <FieldLabel htmlFor={`${id}-confirm`}>
                  <input
                    id={`${id}-confirm`}
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) =>
                      setConfirmed(event.currentTarget.checked)
                    }
                    disabled={locked || !reviewCurrent}
                  />{' '}
                  {m.settings_source_confirm()}
                </FieldLabel>
              </Field>
            </>
          ) : null}
        </>
      )}
      {(review && item.environment !== 'synthetic') ||
      (item.declaration && !item.declaration.revoked) ? (
        <>
          <Field>
            <FieldLabel htmlFor={`${id}-reason`}>
              {m.settings_autonomy_reason()}
            </FieldLabel>
            <Input
              id={`${id}-reason`}
              value={reason}
              maxLength={1000}
              onChange={(event) => setReason(event.currentTarget.value)}
              disabled={locked}
            />
          </Field>
          <div className="settings-autonomy-actions">
            {review && item.environment !== 'synthetic' ? (
              <Button
                disabled={
                  locked || !confirmed || !reason.trim() || !reviewCurrent
                }
                onClick={() => change(false)}
              >
                {m.settings_source_declare()}
              </Button>
            ) : null}
            {item.declaration && !item.declaration.revoked ? (
              <Button
                variant="outline"
                disabled={locked || !reason.trim()}
                onClick={() => change(true)}
              >
                {m.settings_source_revoke()}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      {pending ? <Spinner aria-label={m.common_loading()} /> : null}
      {error ? (
        <Alert tone="warning" role="alert">
          {error}
        </Alert>
      ) : null}
      {uncertain ? (
        <Button
          variant="outline"
          disabled={disabled || pending}
          onClick={() => void send(uncertain)}
        >
          {m.settings_source_check_saved()}
        </Button>
      ) : null}
      {saved ? <p role="status">{saved}</p> : null}
    </article>
  );
}

/** Connection managers review source use explicitly; authenticated reads never certify operational use. */
export function SourceEnvironmentSettings({
  organizationId,
  disabled = false,
}: {
  organizationId: string;
  disabled?: boolean;
}) {
  const { can } = usePermissions(organizationId);
  const context = useQuery(contextOptions(organizationId));
  const online = useSettingsOnline();
  const now = useNow();
  const query = useQuery({
    queryKey: key(organizationId),
    ...privateQueryDefaults,
    enabled: can('connections.manage'),
    refetchInterval: 30_000,
    queryFn: ({ signal }) =>
      api.sourceEnvironments.list({ params: { organizationId } }, { signal }),
  });
  if (!can('connections.manage') || query.data?.available === false)
    return null;

  return (
    <section className="settings-section">
      <SectionHeading
        title={m.settings_source_title()}
        description={m.settings_source_description()}
      />
      {!online ? (
        <Alert tone="warning" role="status">
          {m.common_offline_save()}
        </Alert>
      ) : null}
      {query.isPending ? (
        <Spinner aria-label={m.common_loading()} />
      ) : query.isError ? (
        <Alert tone="warning" role="alert">
          {errorMessage(query.error)}{' '}
          <Button
            variant="outline"
            size="sm"
            disabled={!online}
            onClick={() => void query.refetch()}
          >
            {m.common_try_again()}
          </Button>
        </Alert>
      ) : query.data.items.length ? (
        query.data.items.map((item) => (
          <SourceDeclaration
            key={item.connectionId}
            organizationId={organizationId}
            item={item}
            actorId={context.data?.actor.id}
            now={now}
            disabled={disabled || !online || query.isPaused}
          />
        ))
      ) : (
        <p>{m.settings_source_empty()}</p>
      )}
    </section>
  );
}
