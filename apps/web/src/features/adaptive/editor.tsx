import {
  type AdaptiveView,
  type AdaptiveViewInput,
  adaptiveViewInputSchema,
  type AdaptiveViewQuery,
} from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { usePermissions } from '../../kit/identity/permissions';
import { rolesOptions } from '../../kit/settings/roles-data';
import {
  adaptiveApi,
  adaptiveKey,
  defaultColumns,
  emptyViewQuery,
  previewOptions,
} from './data';
import { adaptiveLabel, columnLabel, domainOptions } from './presentation';
import { QueryExtras } from './query-extras';
import { filterChoices, filterFields, sortFields } from './query-fields';
import { AdaptiveRecords } from './records';

type EditorValues = {
  name: string;
  description: string;
  sharing: AdaptiveViewInput['sharing'];
  query: AdaptiveViewQuery;
  reviewed: boolean;
};

/** Edits a constrained live query and requires a fresh preview before its reviewed version is saved. */
export function ViewEditor({
  organizationId,
  view,
  initialQuery,
  generationEnabled,
  onClose,
}: {
  organizationId: string;
  view?: AdaptiveView;
  initialQuery?: AdaptiveViewQuery;
  generationEnabled: boolean;
  onClose?: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const permissions = usePermissions(organizationId);
  const roles = useQuery({
    ...rolesOptions(organizationId),
    enabled: permissions.ready,
  });
  const [previewed, setPreviewed] = useState<AdaptiveViewQuery | null>(null);
  const [prompt, setPrompt] = useState('');
  const [invalid, setInvalid] = useState(false);
  const customFields = useQuery({
    queryKey: [...adaptiveKey(organizationId), 'editor-fields'],
    queryFn: async () => {
      const [order, product, purchase_order] = await Promise.allSettled([
        adaptiveApi.adaptiveFields.list({
          params: { organizationId },
          query: { recordType: 'order', includeArchived: false },
        }),
        adaptiveApi.adaptiveFields.list({
          params: { organizationId },
          query: { recordType: 'product', includeArchived: false },
        }),
        adaptiveApi.adaptiveFields.list({
          params: { organizationId },
          query: { recordType: 'purchase_order', includeArchived: false },
        }),
      ]);

      return {
        order: order.status === 'fulfilled' ? order.value : [],
        product: product.status === 'fulfilled' ? product.value : [],
        purchase_order:
          purchase_order.status === 'fulfilled' ? purchase_order.value : [],
      };
    },
    enabled: permissions.can('adaptive.fields.read'),
  });
  const [commandId] = useState(() => crypto.randomUUID());
  const defaults: EditorValues = {
    name: view?.name ?? '',
    description: view?.description ?? '',
    sharing: view?.sharing ?? { scope: 'private', roleIds: [] },
    query: view?.query ?? initialQuery ?? emptyViewQuery('orders'),
    reviewed: false,
  };
  const save = useMutation({
    mutationFn: (input: AdaptiveViewInput) =>
      view
        ? adaptiveApi.adaptiveViews.update({
            params: { organizationId, viewId: view.id },
            body: { ...input, expectedRevision: view.revision },
          })
        : adaptiveApi.adaptiveViews.create({
            params: { organizationId },
            body: input,
          }),
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: adaptiveKey(organizationId) });
      void navigate({
        to: '/app/$organizationId/views/$viewId',
        params: { organizationId, viewId: saved.id },
        search: {},
      });
      onClose?.();
    },
  });
  const form = useForm({
    defaultValues: defaults,
    onSubmit: async ({ value }) => {
      const parsed = adaptiveViewInputSchema.safeParse({ ...value, commandId });
      if (
        !parsed.success ||
        !previewed ||
        JSON.stringify(previewed) !== JSON.stringify(value.query)
      ) {
        setInvalid(true);

        return;
      }
      setInvalid(false);
      await save.mutateAsync(parsed.data);
    },
  });
  const generated = useMutation({
    mutationFn: () =>
      adaptiveApi.adaptiveViews.generate({
        params: { organizationId },
        body: { prompt },
      }),
    onSuccess: (draft) => {
      if (draft.status === 'ready' && draft.query) {
        form.setFieldValue('query', draft.query);
        form.setFieldValue('reviewed', false);
        setPreviewed(draft.query);
      }
    },
  });
  const preview = useQuery({
    ...previewOptions(organizationId, previewed ?? emptyViewQuery('orders')),
    enabled: !!previewed,
  });
  const changeQuery = (query: AdaptiveViewQuery) => {
    form.setFieldValue('query', query);
    form.setFieldValue('reviewed', false);
    setPreviewed(null);
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
      className="adaptive-editor"
    >
      <div className="adaptive-editor-form">
        {generationEnabled ? (
          <section className="adaptive-editor-group">
            <h2>{m.adaptive_describe()}</h2>
            <Field>
              <FieldLabel htmlFor="view-prompt">
                {m.adaptive_prompt()}
              </FieldLabel>
              <Textarea
                id="view-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder={m.adaptive_prompt_placeholder()}
                maxLength={2000}
              />
            </Field>
            <p>{m.adaptive_draft_note()}</p>
            <Button
              type="button"
              variant="outline"
              disabled={!prompt.trim() || generated.isPending}
              onClick={() => generated.mutate()}
            >
              {m.adaptive_generate()}
            </Button>
            {generated.data ? (
              <Alert
                tone={generated.data.status === 'ready' ? 'info' : 'warning'}
              >
                <p>{generated.data.explanation}</p>
                {generated.data.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </Alert>
            ) : null}
            {generated.isError ? (
              <Alert tone="warning">{m.adaptive_draft_unavailable()}</Alert>
            ) : null}
          </section>
        ) : null}
        <form.Field name="name">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="view-name">{m.adaptive_name()}</FieldLabel>
              <Input
                id="view-name"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                maxLength={120}
                required
              />
            </Field>
          )}
        </form.Field>
        <form.Field name="description">
          {(field) => (
            <Field>
              <FieldLabel htmlFor="view-description">
                {m.adaptive_description_label()}
              </FieldLabel>
              <Textarea
                id="view-description"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                maxLength={1000}
              />
            </Field>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.values.query}>
          {(query) => {
            const definitions =
              customFields.data?.[
                query.domain === 'orders'
                  ? 'order'
                  : query.domain === 'products'
                    ? 'product'
                    : 'purchase_order'
              ] ?? [];
            const custom = ['orders', 'products', 'procurement'].includes(
              query.domain,
            )
              ? definitions
              : [];
            const fields = [
              ...new Set([
                ...defaultColumns[query.domain],
                ...query.columns,
                ...Object.keys(query.filters),
                ...(preview.data?.availableColumns ?? []),
                ...custom.map((field) => `custom:${field.id}`),
              ]),
            ];
            const options = fields.map((field) => ({
              value: field,
              label: (() => {
                const definition = custom.find(
                  (item) => `custom:${item.id}` === field,
                );

                return definition
                  ? adaptiveLabel(definition.label)
                  : columnLabel(field);
              })(),
            }));
            const filters = filterFields(query.domain).map((field) => ({
              value: field,
              label: columnLabel(field),
            }));
            const sorts = [
              ...sortFields(query.domain).map((field) => ({
                value: field,
                label: columnLabel(field),
              })),
              ...options.filter((option) => option.value.startsWith('custom:')),
            ];

            return (
              <>
                <Field>
                  <FieldLabel>{m.adaptive_domain()}</FieldLabel>
                  <Select
                    aria-label={m.adaptive_domain()}
                    value={query.domain}
                    options={domainOptions()}
                    onValueChange={(domain) => {
                      if (domain) changeQuery(emptyViewQuery(domain));
                    }}
                  />
                </Field>
                <section className="adaptive-editor-group">
                  <h2>{m.adaptive_columns()}</h2>
                  <div className="adaptive-checks">
                    {fields.map((field) => (
                      <label className="adaptive-check" key={field}>
                        <input
                          type="checkbox"
                          checked={query.columns.includes(field)}
                          onChange={(event) =>
                            changeQuery({
                              ...query,
                              columns: event.target.checked
                                ? [...query.columns, field]
                                : query.columns.filter(
                                    (column) => column !== field,
                                  ),
                            })
                          }
                        />
                        {options.find((option) => option.value === field)
                          ?.label ?? columnLabel(field)}
                      </label>
                    ))}
                  </div>
                </section>
                <section className="adaptive-editor-group">
                  <h2>{m.adaptive_filters()}</h2>
                  {Object.entries(query.filters).map(([key, value]) => (
                    <div className="adaptive-filter" key={key}>
                      <Field>
                        <FieldLabel>{m.adaptive_field()}</FieldLabel>
                        <Input
                          value={key}
                          readOnly
                          aria-label={m.adaptive_field()}
                        />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor={`filter-${key}`}>
                          {m.adaptive_value()}
                        </FieldLabel>
                        {filterChoices(query.domain, key).length ? (
                          <Select
                            aria-label={columnLabel(key)}
                            value={typeof value === 'string' ? value : null}
                            options={filterChoices(query.domain, key).map(
                              (choice) => ({
                                value: choice,
                                label: columnLabel(choice),
                              }),
                            )}
                            onValueChange={(selected) => {
                              if (selected)
                                changeQuery({
                                  ...query,
                                  filters: {
                                    ...query.filters,
                                    [key]: selected,
                                  },
                                });
                            }}
                          />
                        ) : (
                          <Input
                            id={`filter-${key}`}
                            value={value === null ? '' : String(value)}
                            onChange={(event) =>
                              changeQuery({
                                ...query,
                                filters: {
                                  ...query.filters,
                                  [key]: event.target.value,
                                },
                              })
                            }
                          />
                        )}
                      </Field>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={m.adaptive_remove()}
                        onClick={() => {
                          const filters = { ...query.filters };
                          delete filters[key];
                          changeQuery({ ...query, filters });
                        }}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                  ))}
                  <Select
                    aria-label={m.adaptive_add_filter()}
                    value={null}
                    placeholder={m.adaptive_add_filter()}
                    options={filters.filter(
                      (option) => !(option.value in query.filters),
                    )}
                    onValueChange={(field) => {
                      if (field)
                        changeQuery({
                          ...query,
                          filters: {
                            ...query.filters,
                            [field]:
                              filterChoices(query.domain, field)[0] ?? '',
                          },
                        });
                    }}
                  />
                </section>
                <div className="adaptive-editor-pair">
                  <Field>
                    <FieldLabel>{m.adaptive_sort()}</FieldLabel>
                    <Select
                      aria-label={m.adaptive_sort()}
                      value={query.sort?.field ?? '__none'}
                      options={[
                        { value: '__none', label: m.adaptive_none() },
                        ...sorts,
                      ]}
                      onValueChange={(field) =>
                        changeQuery({
                          ...query,
                          sort:
                            field && field !== '__none'
                              ? {
                                  field,
                                  direction:
                                    query.domain === 'fulfillment'
                                      ? 'desc'
                                      : (query.sort?.direction ?? 'asc'),
                                }
                              : null,
                        })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{m.adaptive_sort()}</FieldLabel>
                    <Select
                      aria-label={m.adaptive_sort()}
                      value={query.sort?.direction ?? 'asc'}
                      disabled={!query.sort || query.domain === 'fulfillment'}
                      options={[
                        { value: 'asc', label: m.adaptive_ascending() },
                        { value: 'desc', label: m.adaptive_descending() },
                      ]}
                      onValueChange={(direction) => {
                        if (query.sort && direction)
                          changeQuery({
                            ...query,
                            sort: { ...query.sort, direction },
                          });
                      }}
                    />
                  </Field>
                </div>
                <div className="adaptive-editor-pair">
                  <Field>
                    <FieldLabel>{m.adaptive_group()}</FieldLabel>
                    <Select
                      aria-label={m.adaptive_group()}
                      value={query.groupBy ?? '__none'}
                      options={[
                        { value: '__none', label: m.adaptive_none() },
                        ...options,
                      ]}
                      onValueChange={(field) =>
                        changeQuery({
                          ...query,
                          groupBy: field && field !== '__none' ? field : null,
                          layout: field === '__none' ? 'table' : query.layout,
                        })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{m.adaptive_layout()}</FieldLabel>
                    <Select
                      aria-label={m.adaptive_layout()}
                      value={query.layout}
                      options={[
                        { value: 'table', label: m.adaptive_table() },
                        {
                          value: 'board',
                          label: m.adaptive_board(),
                          disabled: !query.groupBy,
                        },
                      ]}
                      onValueChange={(layout) => {
                        if (layout) changeQuery({ ...query, layout });
                      }}
                    />
                  </Field>
                </div>
                <section className="adaptive-editor-group">
                  <h2>{m.adaptive_metrics()}</h2>
                  <label className="adaptive-check">
                    <input
                      type="checkbox"
                      checked={query.metrics.some(
                        (metric) => metric.id === 'record_count',
                      )}
                      onChange={(event) =>
                        changeQuery({
                          ...query,
                          metrics: event.target.checked
                            ? [
                                ...query.metrics,
                                {
                                  id: 'record_count',
                                  operation: 'count',
                                  field: null,
                                },
                              ]
                            : query.metrics.filter(
                                (metric) => metric.id !== 'record_count',
                              ),
                          charts: event.target.checked
                            ? query.charts
                            : query.charts.filter(
                                (chart) => chart.metricId !== 'record_count',
                              ),
                        })
                      }
                    />
                    {m.adaptive_count()}
                  </label>
                  <label className="adaptive-check">
                    <input
                      type="checkbox"
                      disabled={
                        !query.groupBy ||
                        !query.metrics.some(
                          (metric) => metric.id === 'record_count',
                        )
                      }
                      checked={query.charts.some(
                        (chart) => chart.id === 'count_by_group',
                      )}
                      onChange={(event) =>
                        changeQuery({
                          ...query,
                          charts:
                            event.target.checked && query.groupBy
                              ? [
                                  ...query.charts,
                                  {
                                    id: 'count_by_group',
                                    type: 'bar',
                                    groupBy: query.groupBy,
                                    metricId: 'record_count',
                                  },
                                ]
                              : query.charts.filter(
                                  (chart) => chart.id !== 'count_by_group',
                                ),
                        })
                      }
                    />
                    {m.adaptive_chart_group()}
                  </label>
                </section>
                <QueryExtras
                  organizationId={organizationId}
                  query={query}
                  fields={custom}
                  change={changeQuery}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!query.columns.length || preview.isFetching}
                  onClick={() => {
                    setPreviewed(query);
                  }}
                >
                  <Plus aria-hidden="true" />
                  {m.adaptive_preview()}
                </Button>
              </>
            );
          }}
        </form.Subscribe>
        <form.Field name="sharing">
          {(field) => (
            <section className="adaptive-editor-group">
              <Field>
                <FieldLabel>{m.adaptive_sharing()}</FieldLabel>
                <Select
                  aria-label={m.adaptive_sharing()}
                  value={field.state.value.scope}
                  options={[
                    { value: 'private', label: m.adaptive_private() },
                    { value: 'workspace', label: m.adaptive_workspace() },
                    {
                      value: 'roles',
                      label: m.adaptive_roles(),
                      disabled: !roles.data,
                    },
                  ]}
                  onValueChange={(scope) => {
                    if (scope) {
                      field.handleChange({ scope, roleIds: [] });
                      form.setFieldValue('reviewed', false);
                    }
                  }}
                />
              </Field>
              {field.state.value.scope === 'roles' ? (
                <div className="adaptive-checks">
                  {roles.data?.roles.map((role) => (
                    <label className="adaptive-check" key={role.id}>
                      <input
                        type="checkbox"
                        checked={field.state.value.roleIds.includes(role.id)}
                        onChange={(event) =>
                          field.handleChange({
                            ...field.state.value,
                            roleIds: event.target.checked
                              ? [...field.state.value.roleIds, role.id]
                              : field.state.value.roleIds.filter(
                                  (id) => id !== role.id,
                                ),
                          })
                        }
                      />
                      {role.name}
                    </label>
                  ))}
                </div>
              ) : null}
              <p>{m.adaptive_sharing_note()}</p>
            </section>
          )}
        </form.Field>
        <form.Field name="reviewed">
          {(field) => (
            <label className="adaptive-check">
              <input
                type="checkbox"
                checked={field.state.value}
                onChange={(event) => field.handleChange(event.target.checked)}
              />
              {m.adaptive_reviewed()}
            </label>
          )}
        </form.Field>
        {invalid ? (
          <Alert tone="warning" role="alert">
            {m.adaptive_preview_first()}
          </Alert>
        ) : null}
        {save.isError ? (
          <Alert tone="danger" role="alert">
            {m.adaptive_operation_failed()}
          </Alert>
        ) : null}
        <form.Subscribe selector={(state) => state.values.reviewed}>
          {(reviewed) => (
            <div className="adaptive-actions">
              <Button
                type="submit"
                disabled={
                  !reviewed ||
                  !previewed ||
                  preview.isError ||
                  preview.isPending ||
                  save.isPending
                }
              >
                {save.isPending ? m.adaptive_saving() : m.adaptive_save()}
              </Button>
              {onClose ? (
                <Button type="button" variant="outline" onClick={onClose}>
                  {m.adaptive_cancel()}
                </Button>
              ) : null}
            </div>
          )}
        </form.Subscribe>
      </div>
      <section className="adaptive-preview" aria-label={m.adaptive_matching()}>
        {previewed ? (
          preview.isPending ? (
            <Alert role="status">{m.adaptive_loading()}</Alert>
          ) : preview.isError ? (
            <Alert tone="warning">
              {m.adaptive_load_failed()}
              <Button
                type="button"
                variant="outline"
                onClick={() => void preview.refetch()}
              >
                {m.adaptive_retry()}
              </Button>
            </Alert>
          ) : preview.data ? (
            <AdaptiveRecords
              organizationId={organizationId}
              configuration={previewed}
              preview={preview.data}
            />
          ) : null
        ) : (
          <Alert>{m.adaptive_preview_first()}</Alert>
        )}
      </section>
    </form>
  );
}
