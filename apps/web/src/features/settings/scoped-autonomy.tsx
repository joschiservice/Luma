import './settings.css';

import type {
  AutonomyPolicy,
  AutonomyPolicyControl,
  AutonomyTrackRecord,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { SearchableSelect } from '@luma/ui/components/primitives/searchable-select';
import { Spinner } from '@luma/ui/components/primitives/spinner';
import { useForm } from '@tanstack/react-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';

import { usePermissions } from '../../kit/identity/permissions';
import { createWebApiClient } from '../../lib/api-client';
import { ApiError } from '../../lib/api-error';
import { privateQueryDefaults } from '../../lib/private-query';
import { allSuppliersOptions } from '../../shared/procurement/suppliers';
import { SectionHeading } from './section-heading';

const reasons = {
  out_of_scope: m.settings_autonomy_out_of_scope,
  ambiguous_scope: m.settings_autonomy_ambiguous_scope,
  paused: m.settings_autonomy_paused,
  manual: m.settings_autonomy_manual,
  stale_evidence: m.settings_autonomy_stale_evidence,
  quantity_limit: m.settings_autonomy_quantity_limit_reason,
  money_unknown: m.settings_autonomy_money_unknown,
  money_limit: m.settings_autonomy_money_limit,
  risk_floor: m.settings_autonomy_risk_floor,
};
const api = createWebApiClient();
const key = (organizationId: string) =>
  ['private', 'organization', organizationId, 'autonomy'] as const;

type Policy = AutonomyPolicy & { trackRecord: AutonomyTrackRecord };

const errorMessage = (error: unknown) => {
  if (error instanceof ApiError) {
    if (error.status === 409) return m.settings_autonomy_change_conflict();
    if (error.status === 422 || error.status === 400)
      return m.settings_autonomy_change_invalid();
    if (error.status === 401 || error.status === 403)
      return m.settings_autonomy_change_access();
  }

  return m.settings_autonomy_change_unconfirmed();
};

function ScopePicker({
  label,
  values,
  options,
  onChange,
}: {
  label: string;
  values: string[];
  options: { value: string; label: string }[];
  onChange(values: string[]): void;
}) {
  const id = useId();

  return (
    <Field>
      <FieldLabel id={id}>{label}</FieldLabel>
      <SearchableSelect
        aria-labelledby={id}
        value=""
        options={options.filter((item) => !values.includes(item.value))}
        onValueChange={(value) => {
          if (value) onChange([...values, value]);
        }}
      />
      {values.length ? (
        <ul>
          {values.map((value) => (
            <li key={value}>
              {options.find((item) => item.value === value)?.label ??
                m.settings_autonomy_saved_record()}{' '}
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() =>
                  onChange(values.filter((item) => item !== value))
                }
              >
                {m.common_remove()}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-note">{m.settings_autonomy_unrestricted()}</p>
      )}
    </Field>
  );
}

function PolicyEditor({
  organizationId,
  policy,
  onClose,
}: {
  organizationId: string;
  policy?: Policy | undefined;
  onClose(): void;
}) {
  const [error, setError] = useState('');
  const requestIdentity = useRef<
    { fingerprint: string; commandId: string; policyId: string } | undefined
  >(undefined);
  const client = useQueryClient();
  const id = useId();
  const { can } = usePermissions(organizationId);
  const suppliers = useQuery({
    ...allSuppliersOptions(organizationId),
    enabled: can('procurement.read'),
  });
  const orders = useQuery({
    queryKey: [...key(organizationId), 'orders'],
    ...privateQueryDefaults,
    enabled: can('procurement.read'),
    queryFn: ({ signal }) =>
      api.procurement.orders(
        { params: { organizationId }, query: { limit: 50 } },
        { signal },
      ),
  });
  const inventory = useQuery({
    queryKey: [...key(organizationId), 'locations'],
    ...privateQueryDefaults,
    enabled: can('inventory.read'),
    queryFn: ({ signal }) =>
      api.inventory.list(
        { params: { organizationId }, query: { q: '', view: 'all' } },
        { signal },
      ),
  });
  const form = useForm({
    defaultValues: {
      name: policy?.name ?? '',
      supplierIds: policy?.scope.supplierIds ?? ([] as string[]),
      locationIds: policy?.scope.locationIds ?? ([] as string[]),
      recordIds: policy?.scope.recordIds ?? ([] as string[]),
      dailyQuantity: policy?.scope.dailyQuantity ?? '20',
      currency: policy?.scope.money?.currency ?? '',
      perActionMoney: policy?.scope.money?.perAction ?? '',
      dailyMoney: policy?.scope.money?.daily ?? '',
      reason: '',
    },
    onSubmit: async ({ value }) => {
      setError('');
      try {
        const fingerprint = JSON.stringify(value);
        if (requestIdentity.current?.fingerprint !== fingerprint)
          requestIdentity.current = {
            fingerprint,
            commandId: crypto.randomUUID(),
            policyId: policy?.id ?? crypto.randomUUID(),
          };
        const request = requestIdentity.current;
        await api.scopedAutonomy.save({
          params: { organizationId },
          body: {
            commandId: request.commandId,
            id: request.policyId,
            expectedRevision: policy?.revision ?? 0,
            name: value.name,
            reason: value.reason,
            scope: {
              capability: 'procurement.follow-up.record',
              connectionIds: policy?.scope.connectionIds ?? [organizationId],
              supplierIds: value.supplierIds,
              locationIds: value.locationIds,
              recordIds: value.recordIds,
              unit: 'follow_up',
              perActionQuantity: policy?.scope.perActionQuantity ?? '1',
              dailyQuantity: value.dailyQuantity,
              maxEvidenceAgeSeconds: policy?.scope.maxEvidenceAgeSeconds ?? 300,
              money:
                value.currency || value.perActionMoney || value.dailyMoney
                  ? {
                      currency: value.currency.toUpperCase(),
                      perAction: value.perActionMoney,
                      daily: value.dailyMoney,
                    }
                  : null,
            },
          },
        });
        await client.invalidateQueries({ queryKey: key(organizationId) });
        onClose();
      } catch (error) {
        setError(errorMessage(error));
      }
    },
  });
  const locations = [
    ...new Map(
      (inventory.data?.items ?? []).map((position) => [
        position.locationId,
        { value: position.locationId, label: position.location },
      ]),
    ).values(),
  ];
  const selectors = {
    supplierIds: {
      label: m.settings_autonomy_suppliers(),
      options: (suppliers.data?.items ?? []).map((supplier) => ({
        value: supplier.id,
        label: supplier.name,
      })),
    },
    locationIds: { label: m.settings_autonomy_locations(), options: locations },
    recordIds: {
      label: m.settings_autonomy_records(),
      options: (orders.data?.items ?? []).map((order) => ({
        value: order.id,
        label: order.reference,
      })),
    },
  };
  const inputs = [
    { name: 'name', label: m.settings_autonomy_name(), required: true },
    {
      name: 'dailyQuantity',
      label: m.settings_autonomy_daily_quantity(),
      required: true,
    },
    {
      name: 'currency',
      label: m.settings_autonomy_currency(),
      required: false,
    },
    {
      name: 'perActionMoney',
      label: m.settings_autonomy_per_money(),
      required: false,
    },
    {
      name: 'dailyMoney',
      label: m.settings_autonomy_daily_money(),
      required: false,
    },
    { name: 'reason', label: m.settings_autonomy_reason(), required: true },
  ] as const;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle>
          {policy ? m.settings_autonomy_edit() : m.settings_autonomy_create()}
        </DialogTitle>
        <DialogDescription>
          {m.settings_autonomy_scope_help()}
        </DialogDescription>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            {error ? (
              <Alert tone="danger" role="alert">
                {error}
              </Alert>
            ) : null}
            <p className="settings-note">{m.settings_autonomy_internal()}</p>
            {suppliers.isError || orders.isError || inventory.isError ? (
              <Alert tone="warning">
                {m.settings_autonomy_catalog_failed()}
              </Alert>
            ) : null}
            {inventory.data?.nextCursor ? (
              <Alert tone="neutral">
                {m.settings_autonomy_locations_partial()}
              </Alert>
            ) : null}
            {suppliers.data?.truncated ? (
              <Alert tone="neutral">
                {m.settings_autonomy_suppliers_partial()}
              </Alert>
            ) : null}
            {orders.data?.nextCursor ? (
              <Alert tone="neutral">
                {m.settings_autonomy_records_partial()}
              </Alert>
            ) : null}
            {(['supplierIds', 'locationIds', 'recordIds'] as const).map(
              (name) => (
                <form.Field key={name} name={name}>
                  {(field) => (
                    <ScopePicker
                      label={selectors[name].label}
                      values={field.state.value}
                      options={selectors[name].options}
                      onChange={field.handleChange}
                    />
                  )}
                </form.Field>
              ),
            )}
            {inputs.map(({ name, label, required }) => (
              <form.Field key={name} name={name}>
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={`${id}-${name}`}>{label}</FieldLabel>
                    <Input
                      id={`${id}-${name}`}
                      value={field.state.value}
                      required={required}
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.target.value)
                      }
                    />
                  </Field>
                )}
              </form.Field>
            ))}
            <p className="settings-note">{m.settings_autonomy_money_help()}</p>
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(pending) => (
                <div className="settings-autonomy-actions">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onClose}
                    disabled={pending}
                  >
                    {m.common_cancel()}
                  </Button>
                  <Button type="submit" disabled={pending}>
                    {pending ? m.common_saving() : m.common_save()}
                  </Button>
                </div>
              )}
            </form.Subscribe>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PolicyControl({
  organizationId,
  policy,
  kind,
  connectionId,
  onClose,
}: {
  organizationId: string;
  policy: Policy;
  kind: AutonomyPolicyControl['kind'];
  connectionId?: string | undefined;
  onClose(): void;
}) {
  const client = useQueryClient();
  const [error, setError] = useState('');
  const id = useId();
  const requestIdentity = useRef<{ fingerprint: string; commandId: string }>(
    undefined,
  );
  const form = useForm({
    defaultValues: { reason: '' },
    onSubmit: async ({ value }) => {
      setError('');
      try {
        const fingerprint = JSON.stringify(value);
        if (requestIdentity.current?.fingerprint !== fingerprint)
          requestIdentity.current = {
            fingerprint,
            commandId: crypto.randomUUID(),
          };
        await api.scopedAutonomy.control({
          params: { organizationId, policyId: policy.id },
          body: {
            commandId: requestIdentity.current.commandId,
            expectedRevision: policy.revision,
            kind,
            connectionId,
            reason: value.reason,
          },
        });
        await client.invalidateQueries({ queryKey: key(organizationId) });
        onClose();
      } catch (error) {
        setError(errorMessage(error));
      }
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle>
          {m.settings_autonomy_review_control({ name: policy.name })}
        </DialogTitle>
        <DialogDescription>
          {kind === 'promote'
            ? m.settings_autonomy_promotion_rule()
            : m.settings_autonomy_control_help()}
        </DialogDescription>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <FieldGroup>
            {error ? (
              <Alert tone="danger" role="alert">
                {error}
              </Alert>
            ) : null}
            <form.Field name="reason">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={id}>
                    {m.settings_autonomy_reason()}
                  </FieldLabel>
                  <Input
                    id={id}
                    required
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                </Field>
              )}
            </form.Field>
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(pending) => (
                <Button type="submit" disabled={pending}>
                  {m.settings_autonomy_confirm()}
                </Button>
              )}
            </form.Subscribe>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Preview({
  organizationId,
  policy,
  onClose,
}: {
  organizationId: string;
  policy: Policy;
  onClose(): void;
}) {
  const query = useQuery({
    queryKey: [...key(organizationId), policy.id, policy.revision, 'preview'],
    ...privateQueryDefaults,
    queryFn: ({ signal }) =>
      api.scopedAutonomy.preview(
        { params: { organizationId, policyId: policy.id } },
        { signal },
      ),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogTitle>{m.settings_autonomy_preview()}</DialogTitle>
        <DialogDescription>
          {m.settings_autonomy_preview_help()}
        </DialogDescription>
        {query.isPending ? (
          <Spinner aria-label={m.common_loading()} />
        ) : query.isError ? (
          <Alert tone="warning" role="alert">
            {errorMessage(query.error)}
          </Alert>
        ) : (
          <>
            <p>
              {m.settings_autonomy_evidence_counts({
                live: query.data.trackRecord.live,
                synthetic: query.data.trackRecord.synthetic,
                unknown: query.data.trackRecord.unknown,
              })}
            </p>
            {query.data.samples.length ? (
              <ul>
                {query.data.samples.map((sample) => (
                  <li key={sample.proposalId}>
                    <Badge>
                      {sample.environment === 'live'
                        ? m.settings_autonomy_live()
                        : sample.environment === 'synthetic'
                          ? m.settings_autonomy_synthetic()
                          : m.settings_autonomy_unknown()}
                    </Badge>{' '}
                    {sample.outcome === 'allowed'
                      ? m.settings_autonomy_would_allow()
                      : sample.outcome === 'approval_required'
                        ? m.settings_autonomy_would_review()
                        : m.settings_autonomy_would_block()}{' '}
                    {sample.reason ? `· ${reasons[sample.reason]()}` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p>{m.settings_autonomy_preview_empty()}</p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Versioned bounded delegation controls, historical evidence and explicit earned promotion in workspace Settings. */
export function ScopedAutonomySettings({
  organizationId,
  disabled = false,
}: {
  organizationId: string;
  disabled?: boolean;
}) {
  const { can } = usePermissions(organizationId);
  const query = useQuery({
    queryKey: key(organizationId),
    ...privateQueryDefaults,
    enabled: can('workspace.approval_policy.manage'),
    queryFn: ({ signal }) =>
      api.scopedAutonomy.list({ params: { organizationId } }, { signal }),
  });
  const [edit, setEdit] = useState<Policy | 'new'>();
  const [control, setControl] = useState<{
    policy: Policy;
    kind: AutonomyPolicyControl['kind'];
    connectionId?: string;
  }>();
  const [preview, setPreview] = useState<Policy>();
  if (
    !can('workspace.approval_policy.manage') ||
    query.data?.available === false
  )
    return null;
  const percentage = (value: number | null) =>
    value === null
      ? m.settings_autonomy_not_measured()
      : formatNumber(value, { style: 'percent', maximumFractionDigits: 0 });

  return (
    <section className="settings-section">
      <SectionHeading
        title={m.settings_autonomy_title()}
        description={m.settings_autonomy_description()}
      />
      {query.isPending ? (
        <Spinner aria-label={m.common_loading()} />
      ) : query.isError ? (
        <Alert tone="warning" role="alert">
          {errorMessage(query.error)}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
          >
            {m.common_try_again()}
          </Button>
        </Alert>
      ) : (
        <>
          <Alert tone="neutral">{m.settings_autonomy_promotion_rule()}</Alert>
          {query.data.policies.length ? (
            query.data.policies.map((policy) => (
              <article
                key={policy.id}
                className="settings-panel settings-autonomy-policy"
              >
                <h3>
                  {policy.name}{' '}
                  <Badge>
                    {policy.revoked
                      ? m.settings_autonomy_revoked()
                      : policy.paused
                        ? m.settings_autonomy_paused()
                        : policy.mode === 'manual'
                          ? m.settings_autonomy_manual()
                          : policy.mode === 'assisted'
                            ? m.settings_autonomy_assisted()
                            : m.settings_autonomy_autonomous()}
                  </Badge>
                </h3>
                <p>
                  {m.settings_autonomy_quantity_limit({
                    count: formatNumber(Number(policy.scope.dailyQuantity)),
                  })}
                </p>
                <p>
                  {m.settings_autonomy_rates({
                    acceptance: percentage(policy.trackRecord.acceptanceRate),
                    overrides: percentage(policy.trackRecord.overrideRate),
                    agreement: percentage(
                      policy.trackRecord.reviewerAgreementRate,
                    ),
                    verification: percentage(
                      policy.trackRecord.verificationPassRate,
                    ),
                  })}
                </p>
                <p>
                  {m.settings_autonomy_evidence_counts({
                    live: policy.trackRecord.live,
                    synthetic: policy.trackRecord.synthetic,
                    unknown: policy.trackRecord.unknown,
                  })}
                </p>
                {policy.circuitReason ? (
                  <Alert tone="warning">{m.settings_autonomy_circuit()}</Alert>
                ) : null}
                <div className="settings-autonomy-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPreview(policy)}
                  >
                    {m.settings_autonomy_preview()}
                  </Button>
                  {!policy.revoked ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={disabled}
                        onClick={() => setEdit(policy)}
                      >
                        {m.settings_autonomy_edit()}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={disabled}
                        onClick={() =>
                          setControl({
                            policy,
                            kind: policy.paused ? 'resume' : 'pause',
                          })
                        }
                      >
                        {policy.paused
                          ? m.settings_autonomy_resume()
                          : m.settings_autonomy_pause()}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={disabled}
                        onClick={() =>
                          setControl({
                            policy,
                            kind: policy.pausedConnectionIds.includes(
                              organizationId,
                            )
                              ? 'resume'
                              : 'pause',
                            connectionId: organizationId,
                          })
                        }
                      >
                        {policy.pausedConnectionIds.includes(organizationId)
                          ? m.settings_autonomy_resume_connection()
                          : m.settings_autonomy_pause_connection()}
                      </Button>
                      {policy.mode === 'manual' ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={disabled || policy.paused}
                          onClick={() => setControl({ policy, kind: 'assist' })}
                        >
                          {m.settings_autonomy_enable_assisted()}
                        </Button>
                      ) : null}
                      {policy.mode !== 'autonomous' ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={
                            disabled ||
                            policy.paused ||
                            !policy.trackRecord.promotionEligible
                          }
                          onClick={() =>
                            setControl({ policy, kind: 'promote' })
                          }
                        >
                          {m.settings_autonomy_promote()}
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={disabled}
                        onClick={() => setControl({ policy, kind: 'revoke' })}
                      >
                        {m.settings_autonomy_revoke()}
                      </Button>
                    </>
                  ) : null}
                </div>
              </article>
            ))
          ) : (
            <p>{m.settings_autonomy_empty()}</p>
          )}
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => setEdit('new')}
          >
            {m.settings_autonomy_create()}
          </Button>
        </>
      )}
      {edit ? (
        <PolicyEditor
          organizationId={organizationId}
          policy={edit === 'new' ? undefined : edit}
          onClose={() => setEdit(undefined)}
        />
      ) : null}
      {control ? (
        <PolicyControl
          organizationId={organizationId}
          {...control}
          onClose={() => setControl(undefined)}
        />
      ) : null}
      {preview ? (
        <Preview
          organizationId={organizationId}
          policy={preview}
          onClose={() => setPreview(undefined)}
        />
      ) : null}
    </section>
  );
}
