import './supplier-terms.css';

import type {
  SupplierProductTerms,
  SupplierTermsInput,
} from '@luma/api-contract';
import { supplierTermsInputSchema } from '@luma/api-contract';
import {
  formatDate,
  formatExactQuantity,
  formatNumber,
} from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useDeferredValue, useId, useState } from 'react';

import { useCan } from '../../kit/identity/permissions';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';
import { allSuppliersOptions } from './suppliers';

const api = createWebApiClient();

type Values = SupplierProductTerms['effective'];

type Term = keyof Values;

const labels: Record<Term, () => string> = {
  supplierArticleNumber: m.procurement_terms_article,
  unitPrice: m.procurement_terms_price,
  packSize: m.procurement_terms_pack,
  lineMinimumQuantity: m.procurement_terms_minimum,
  orderMinimumValue: m.procurement_terms_order_minimum,
  leadTimeDays: m.procurement_terms_lead,
  preferred: m.procurement_terms_preferred,
};

function valueText(value: Values[Term], key: Term): string {
  if (value == null) return m.procurement_terms_missing();
  if (typeof value === 'boolean')
    return value ? m.procurement_terms_yes() : m.procurement_terms_no();
  if (typeof value === 'number')
    return key === 'leadTimeDays'
      ? m.procurement_terms_days({ days: formatNumber(value) })
      : formatNumber(value);
  if (typeof value === 'string') return value;

  const price = `${formatExactQuantity(value.amount)} ${value.currency ?? m.procurement_terms_currency_unknown()}`;

  return 'validFrom' in value && value.validFrom
    ? m.procurement_terms_price_valid({
        price,
        date: formatDate(value.validFrom, { timeZone: 'UTC' }),
      })
    : price;
}

/** Shows all supplier choices, explicit missing values and the evidence a human overrides. */
export function SupplierTermsSection({
  organizationId,
  supplierId,
  skuId,
}: {
  organizationId: string;
  supplierId?: string;
  skuId?: string;
}) {
  const canRead = useCan(organizationId, 'procurement.read');
  const client = useQueryClient();
  const query = useQuery({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'procurement',
      'supplier-terms',
      { supplierId, skuId },
    ],
    ...privateQueryDefaults,
    enabled: canRead,
    queryFn: ({ signal }) =>
      api.procurement.supplierTerms(
        { params: { organizationId }, query: { supplierId, skuId } },
        { signal },
      ),
  });
  const [editing, setEditing] = useState<SupplierProductTerms | 'new' | null>(
    null,
  );
  if (!canRead || query.data?.enabled === false) return null;

  return (
    <Card as="section" className="supplier-terms">
      <div className="supplier-terms-heading">
        <h2>{m.procurement_terms_title()}</h2>
        {query.data?.canManage ? (
          <Button variant="outline" onClick={() => setEditing('new')}>
            {m.procurement_terms_add()}
          </Button>
        ) : null}
      </div>
      <p className="supplier-terms-note">{m.procurement_terms_note()}</p>
      {query.isPending ? <p role="status">{m.common_loading()}</p> : null}
      {query.error ? (
        <Alert role="alert" tone="danger">
          <p>{m.procurement_terms_unavailable()}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            {m.common_retry()}
          </Button>
        </Alert>
      ) : null}
      {query.data?.items.length === 0 ? (
        <p>{m.procurement_terms_empty()}</p>
      ) : null}
      {query.data?.items.map((item) => (
        <section key={`${item.supplierId}:${item.skuId}`}>
          <div className="supplier-terms-heading">
            <h3>
              {skuId ? (
                <Link
                  to="/app/$organizationId/procurement/suppliers/$supplierId"
                  params={{ organizationId, supplierId: item.supplierId }}
                >
                  {item.supplierName}
                </Link>
              ) : (
                <Link
                  to="/app/$organizationId/products/$skuId"
                  params={{ organizationId, skuId: item.skuId }}
                >
                  {item.sku}
                </Link>
              )}
            </h3>
            {query.data?.canManage ? (
              <Button variant="ghost" onClick={() => setEditing(item)}>
                {m.common_edit()}
              </Button>
            ) : null}
          </div>
          <DataTable
            caption={m.procurement_terms_title()}
            density="compact"
            rows={Object.keys(labels) as Term[]}
            rowKey={(key) => key}
            columns={[
              {
                key: 'term',
                header: m.procurement_terms_term(),
                cell: (key) => labels[key](),
              },
              {
                key: 'effective',
                header: m.procurement_terms_effective(),
                cell: (key) => valueText(item.effective[key], key),
              },
              {
                key: 'observed',
                header: m.procurement_terms_observed(),
                cell: (key) => {
                  const source = item.history
                    .filter((v) => v.source !== 'manual' && key in v.values)
                    .at(-1);

                  return (
                    <span className="supplier-terms-cell">
                      <span>{valueText(source?.values[key] ?? null, key)}</span>
                      {source ? (
                        <small>
                          <WorkspaceDate
                            value={item.lastReadAt ?? source.observedAt}
                          />
                          {!(item.lastReadComplete ?? source.complete)
                            ? ` · ${m.procurement_terms_incomplete()}`
                            : ''}
                        </small>
                      ) : null}
                    </span>
                  );
                },
              },
              {
                key: 'override',
                header: m.procurement_terms_override(),
                cell: (key) => {
                  const source = item.history
                    .filter((v) => v.source === 'manual' && key in v.values)
                    .at(-1);

                  return source ? (
                    <span className="supplier-terms-cell">
                      <span>{valueText(source.values[key] ?? null, key)}</span>
                      <small>
                        {source.actorId} ·{' '}
                        <WorkspaceDate value={source.recordedAt} />
                      </small>
                      <small>{source.reason}</small>
                    </span>
                  ) : (
                    m.procurement_terms_no_override()
                  );
                },
              },
            ]}
          />
          <details className="supplier-terms-evidence">
            <summary>{m.procurement_terms_history()}</summary>
            <ul className="supplier-terms-history">
              {[...item.history].reverse().map((version) => (
                <li key={version.id}>
                  <span>
                    <Badge>
                      {version.source === 'provider'
                        ? m.procurement_terms_provider()
                        : version.source === 'import'
                          ? m.procurement_terms_import()
                          : m.procurement_terms_manual()}
                    </Badge>{' '}
                    <WorkspaceDate value={version.observedAt} />
                  </span>
                  <span>
                    {(Object.keys(labels) as Term[])
                      .filter((key) => key in version.values)
                      .map(
                        (key) =>
                          `${labels[key]()} ${valueText(version.values[key] ?? null, key)}`,
                      )
                      .join(' · ')}
                  </span>
                  <small>
                    {version.actorId} · {version.reason}
                  </small>
                  {version.sourceRecordId ? (
                    <small>{version.sourceRecordId}</small>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        </section>
      ))}
      {editing ? (
        <TermsDialog
          organizationId={organizationId}
          supplierId={supplierId}
          skuId={skuId}
          existing={editing === 'new' ? undefined : editing}
          close={() => setEditing(null)}
          saved={() => {
            setEditing(null);
            void client.invalidateQueries({
              queryKey: [
                'private',
                'organization',
                organizationId,
                'procurement',
              ],
            });
          }}
        />
      ) : null}
    </Card>
  );
}

function TermsDialog({
  organizationId,
  supplierId,
  skuId,
  existing,
  close,
  saved,
}: {
  organizationId: string;
  supplierId?: string | undefined;
  skuId?: string | undefined;
  existing?: SupplierProductTerms | undefined;
  close: () => void;
  saved: () => void;
}) {
  const prefix = useId();
  const [id] = useState(() => crypto.randomUUID());
  const [invalid, setInvalid] = useState(false);
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search);
  const products = useQuery({
    queryKey: [
      'private',
      'organization',
      organizationId,
      'terms-product-picker',
      deferred,
    ],
    ...privateQueryDefaults,
    enabled: !skuId && !existing,
    queryFn: ({ signal }) =>
      api.products.list(
        {
          params: { organizationId },
          query: { q: deferred, view: 'all', limit: 50 },
        },
        { signal },
      ),
  });
  const suppliers = useQuery({
    ...allSuppliersOptions(organizationId),
    enabled: !supplierId && !existing,
  });
  const mutation = useMutation({
    mutationFn: (body: SupplierTermsInput) =>
      api.procurement.saveSupplierTerms({ params: { organizationId }, body }),
    onSuccess: saved,
  });
  const uncertain = mutation.isError;
  const locked = mutation.isPending || uncertain;
  const form = useForm({
    defaultValues: {
      supplierId: existing?.supplierId ?? supplierId ?? '',
      skuId: existing?.skuId ?? skuId ?? '',
      term: 'supplierArticleNumber' as Term,
      value: '',
      currency: '',
      validFrom: '',
      reason: '',
    },
    onSubmit: async ({ value }) => {
      if (uncertain && mutation.variables) {
        mutation.mutate(mutation.variables);

        return;
      }
      let termValue: unknown = value.value.trim() || null;
      if (value.term === 'unitPrice' || value.term === 'orderMinimumValue')
        termValue = value.value
          ? {
              amount: value.value,
              currency: value.currency || null,
              ...(value.term === 'unitPrice'
                ? { validFrom: value.validFrom || null }
                : {}),
            }
          : null;
      else if (
        ['packSize', 'lineMinimumQuantity', 'leadTimeDays'].includes(value.term)
      )
        termValue = value.value ? Number(value.value) : null;
      else if (value.term === 'preferred')
        termValue = value.value === '' ? null : value.value === 'true';
      const body = supplierTermsInputSchema.safeParse({
        id,
        supplierId: value.supplierId,
        skuId: value.skuId,
        expectedRevision: existing?.revision ?? 0,
        reason: value.reason,
        values: { [value.term]: termValue },
      });
      setInvalid(!body.success);
      if (body.success) mutation.mutate(body.data);
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !locked) close();
      }}
    >
      <DialogContent>
        <DialogTitle>{m.procurement_terms_edit_title()}</DialogTitle>
        <DialogDescription>{m.procurement_terms_edit_note()}</DialogDescription>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          {!existing && !supplierId ? (
            <form.Field name="supplierId">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={`${prefix}-supplier`}>
                    {m.procurement_terms_supplier()}
                  </FieldLabel>
                  <Select
                    id={`${prefix}-supplier`}
                    value={field.state.value}
                    onValueChange={(value) => field.handleChange(value ?? '')}
                    options={(suppliers.data?.items ?? []).map((s) => ({
                      value: s.id,
                      label: s.name,
                    }))}
                    disabled={locked}
                  />
                </Field>
              )}
            </form.Field>
          ) : null}
          {!existing && !skuId ? (
            <>
              <Field>
                <FieldLabel htmlFor={`${prefix}-search`}>
                  {m.procurement_terms_search_product()}
                </FieldLabel>
                <Input
                  id={`${prefix}-search`}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  disabled={locked}
                />
              </Field>
              <form.Field name="skuId">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={`${prefix}-product`}>
                      {m.procurement_terms_product()}
                    </FieldLabel>
                    <Select
                      id={`${prefix}-product`}
                      value={field.state.value}
                      onValueChange={(value) => field.handleChange(value ?? '')}
                      options={(products.data?.items ?? []).map((item) => ({
                        value: item.skuId,
                        label: item.listings
                          .map((l) => l.code ?? l.productTitle ?? item.skuId)
                          .join(' / '),
                      }))}
                      disabled={locked}
                    />
                  </Field>
                )}
              </form.Field>
            </>
          ) : null}
          <form.Field name="term">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${prefix}-term`}>
                  {m.procurement_terms_term()}
                </FieldLabel>
                <Select
                  id={`${prefix}-term`}
                  value={field.state.value}
                  onValueChange={(value) => {
                    field.handleChange(value ?? 'supplierArticleNumber');
                    form.setFieldValue('value', '');
                  }}
                  options={(Object.keys(labels) as Term[]).map((key) => ({
                    value: key,
                    label: labels[key](),
                  }))}
                  disabled={locked}
                />
              </Field>
            )}
          </form.Field>
          <form.Subscribe
            selector={(state) => ({
              term: state.values.term,
              value: state.values.value,
            })}
          >
            {({ term, value }) => (
              <>
                <form.Field name="value">
                  {(field) => (
                    <Field>
                      <FieldLabel htmlFor={`${prefix}-value`}>
                        {m.procurement_terms_value()}
                      </FieldLabel>
                      {term === 'preferred' ? (
                        <Select
                          id={`${prefix}-value`}
                          value={field.state.value}
                          onValueChange={(value) =>
                            field.handleChange(value ?? '')
                          }
                          options={[
                            { value: '', label: m.procurement_terms_missing() },
                            { value: 'true', label: m.procurement_terms_yes() },
                            { value: 'false', label: m.procurement_terms_no() },
                          ]}
                          disabled={locked}
                        />
                      ) : (
                        <Input
                          id={`${prefix}-value`}
                          value={field.state.value}
                          onChange={(event) =>
                            field.handleChange(event.target.value)
                          }
                          type={
                            term === 'supplierArticleNumber' ? 'text' : 'number'
                          }
                          min={term === 'packSize' ? '0.000001' : '0'}
                          step={term === 'leadTimeDays' ? '1' : 'any'}
                          disabled={locked}
                        />
                      )}
                    </Field>
                  )}
                </form.Field>
                {term === 'unitPrice' || term === 'orderMinimumValue' ? (
                  <form.Field name="currency">
                    {(field) => (
                      <Field>
                        <FieldLabel htmlFor={`${prefix}-currency`}>
                          {m.procurement_terms_currency()}
                        </FieldLabel>
                        <Input
                          id={`${prefix}-currency`}
                          value={field.state.value}
                          onChange={(event) =>
                            field.handleChange(event.target.value.toUpperCase())
                          }
                          maxLength={3}
                          pattern="[A-Z]{3}"
                          required={!!value}
                          disabled={locked}
                        />
                      </Field>
                    )}
                  </form.Field>
                ) : null}
                {term === 'unitPrice' ? (
                  <form.Field name="validFrom">
                    {(field) => (
                      <Field>
                        <FieldLabel htmlFor={`${prefix}-valid`}>
                          {m.procurement_terms_valid_from()}
                        </FieldLabel>
                        <Input
                          id={`${prefix}-valid`}
                          value={field.state.value}
                          onChange={(event) =>
                            field.handleChange(event.target.value)
                          }
                          type="date"
                          required={!!value}
                          disabled={locked}
                        />
                      </Field>
                    )}
                  </form.Field>
                ) : null}
              </>
            )}
          </form.Subscribe>
          <form.Field name="reason">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${prefix}-reason`}>
                  {m.procurement_terms_reason()}
                </FieldLabel>
                <Input
                  id={`${prefix}-reason`}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  required
                  maxLength={1000}
                  disabled={locked}
                />
              </Field>
            )}
          </form.Field>
          {invalid ? (
            <Alert role="alert" tone="danger">
              {m.procurement_terms_invalid()}
            </Alert>
          ) : null}
          {mutation.error ? (
            <Alert role="alert" tone="danger">
              {m.procurement_terms_save_failed()}
            </Alert>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={close}
              disabled={mutation.isPending}
            >
              {m.common_cancel()}
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {uncertain ? m.common_retry() : m.common_save()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
