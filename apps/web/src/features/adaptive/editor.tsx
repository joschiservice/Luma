import {
  type AdaptiveView,
  type AdaptiveViewInput,
  adaptiveViewInputSchema,
  type AdaptiveViewQuery,
  collectionCatalogs,
  type CollectionColumn,
  type CollectionGranularity,
  type CustomField,
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
import { Plus } from 'lucide-react';
import { useState } from 'react';

import { usePermissions } from '../../kit/identity/permissions';
import { rolesOptions } from '../../kit/settings/roles-data';
import { ConditionRows } from './conditions';
import {
  adaptiveApi,
  adaptiveKey,
  emptyViewQuery,
  previewOptions,
} from './data';
import {
  adaptiveLabel,
  columnLabel,
  domainLabel,
  domainOptions,
  optionLabel,
  segmentLabel,
} from './presentation';
import { QueryExtras } from './query-extras';
import {
  columnFields,
  conditionFields,
  customRecordType,
  groupFields,
  invalidConditions,
  metricFields,
  previewable,
  sortFields,
  viewColumns,
} from './query-fields';
import { AdaptiveRecords } from './records';

/** Record types whose custom fields the previewable lists show. */
type EditorRecordType = 'order' | 'product' | 'purchase_order';

function editorRecordType(type: string | null): type is EditorRecordType {
  return type === 'order' || type === 'product' || type === 'purchase_order';
}

/** Keeps a column's saved width when the column stays shown. */
function widthOf(columns: readonly CollectionColumn[], id: string) {
  const width = columns.find((column) => column.id === id)?.width;

  return width === undefined ? {} : { width };
}

function periodLabel(granularity: CollectionGranularity) {
  return {
    day: m.adaptive_period_day,
    week: m.adaptive_period_week,
    month: m.adaptive_period_month,
  }[granularity]();
}

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

      const loaded: Record<EditorRecordType, CustomField[]> = {
        order: order.status === 'fulfilled' ? order.value : [],
        product: product.status === 'fulfilled' ? product.value : [],
        purchase_order:
          purchase_order.status === 'fulfilled' ? purchase_order.value : [],
      };

      return loaded;
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
        search: { manage: true },
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
            const recordType = customRecordType(query.domain);
            const custom = editorRecordType(recordType)
              ? (customFields.data?.[recordType] ?? [])
              : [];
            const label = (field: string) => {
              const definition = custom.find(
                (item) => `custom:${item.id}` === field,
              );

              return definition
                ? adaptiveLabel(definition.label)
                : columnLabel(field);
            };
            const state = query.state;
            const columns = viewColumns(query);
            const columnOptions = [
              ...new Set([...columnFields(query.domain, custom), ...columns]),
            ];
            const conditions = conditionFields(query.domain, custom);
            const sorts = sortFields(query.domain, custom);
            const groups = groupFields(query.domain, custom);
            const grouping = groups.find(
              (item) => item.id === state.group?.field,
            );
            const changeState = (next: Partial<typeof state>) =>
              changeQuery({ ...query, state: { ...state, ...next } });
            const conditionsInvalid =
              invalidConditions(conditions, state.where.conditions).length > 0;

            return (
              <>
                <Field>
                  <FieldLabel>{m.adaptive_domain()}</FieldLabel>
                  <Select
                    aria-label={m.adaptive_domain()}
                    value={previewable(query.domain) ? query.domain : null}
                    placeholder={domainLabel(query.domain)}
                    options={domainOptions()}
                    onValueChange={(domain) => {
                      if (domain) changeQuery(emptyViewQuery(domain));
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel>{m.adaptive_segment()}</FieldLabel>
                  <Select
                    aria-label={m.adaptive_segment()}
                    value={state.segment ?? '__default'}
                    options={[
                      {
                        value: '__default',
                        label: m.adaptive_segment_default(),
                      },
                      ...[
                        ...new Set([
                          ...collectionCatalogs[query.domain].segments,
                          ...(state.segment ? [state.segment] : []),
                        ]),
                      ].map((segment) => ({
                        value: segment,
                        label: segmentLabel(segment),
                      })),
                    ]}
                    onValueChange={(segment) =>
                      changeState({
                        segment:
                          segment && segment !== '__default' ? segment : null,
                      })
                    }
                  />
                </Field>
                <section className="adaptive-editor-group">
                  <h2>{m.adaptive_columns()}</h2>
                  <div className="adaptive-checks">
                    {columnOptions.map((field) => (
                      <label className="adaptive-check" key={field}>
                        <input
                          type="checkbox"
                          checked={columns.includes(field)}
                          onChange={(event) =>
                            changeState({
                              columns: (event.target.checked
                                ? [...columns, field]
                                : columns.filter((column) => column !== field)
                              ).map((id) => ({
                                id,
                                ...widthOf(state.columns, id),
                              })),
                            })
                          }
                        />
                        {label(field)}
                      </label>
                    ))}
                  </div>
                </section>
                <section className="adaptive-editor-group">
                  <h2>{m.adaptive_filters()}</h2>
                  <ConditionRows
                    fields={conditions}
                    where={state.where}
                    label={label}
                    optionLabel={(field, option) => {
                      const choice = field.custom?.choices.find(
                        (item) => item.key === option,
                      );

                      return choice
                        ? adaptiveLabel(choice.label)
                        : optionLabel(query.domain, field.id, option);
                    }}
                    allowed={(field) =>
                      !field.permission || permissions.can(field.permission)
                    }
                    onChange={(where) => changeState({ where })}
                  />
                </section>
                <div className="adaptive-editor-pair">
                  <Field>
                    <FieldLabel>{m.adaptive_sort()}</FieldLabel>
                    <Select
                      aria-label={m.adaptive_sort()}
                      value={state.sort?.field ?? '__none'}
                      options={[
                        { value: '__none', label: m.adaptive_none() },
                        ...[
                          ...new Set([
                            ...sorts,
                            ...(state.sort ? [state.sort.field] : []),
                          ]),
                        ].map((field) => ({
                          value: field,
                          label: label(field),
                        })),
                      ]}
                      onValueChange={(field) =>
                        changeState({
                          sort:
                            field && field !== '__none'
                              ? {
                                  field,
                                  direction: state.sort?.direction ?? 'asc',
                                }
                              : null,
                        })
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{m.adaptive_sort_direction()}</FieldLabel>
                    <Select
                      aria-label={m.adaptive_sort_direction()}
                      value={state.sort?.direction ?? 'asc'}
                      disabled={!state.sort}
                      options={[
                        { value: 'asc', label: m.adaptive_ascending() },
                        { value: 'desc', label: m.adaptive_descending() },
                      ]}
                      onValueChange={(direction) => {
                        if (state.sort && direction)
                          changeState({ sort: { ...state.sort, direction } });
                      }}
                    />
                  </Field>
                </div>
                <div className="adaptive-editor-pair">
                  <Field>
                    <FieldLabel>{m.adaptive_group()}</FieldLabel>
                    <Select
                      aria-label={m.adaptive_group()}
                      value={state.group?.field ?? '__none'}
                      options={[
                        { value: '__none', label: m.adaptive_none() },
                        ...[
                          ...new Set([
                            ...groups.map((item) => item.id),
                            ...(state.group ? [state.group.field] : []),
                          ]),
                        ].map((field) => ({
                          value: field,
                          label: label(field),
                        })),
                      ]}
                      onValueChange={(field) => {
                        const next = groups.find((item) => item.id === field);
                        changeQuery({
                          ...query,
                          state: {
                            ...state,
                            group: next
                              ? {
                                  field: next.id,
                                  showEmpty: false,
                                  ...(next.granularities?.[0]
                                    ? { granularity: next.granularities[0] }
                                    : {}),
                                }
                              : null,
                            layout:
                              next || state.layout !== 'board'
                                ? state.layout
                                : 'table',
                          },
                          charts: next
                            ? query.charts.map((chart) =>
                                chart.id === 'count_by_group'
                                  ? { ...chart, groupBy: next.id }
                                  : chart,
                              )
                            : query.charts.filter(
                                (chart) => chart.id !== 'count_by_group',
                              ),
                        });
                      }}
                    />
                  </Field>
                  {grouping?.granularities && state.group ? (
                    <Field>
                      <FieldLabel>{m.adaptive_period()}</FieldLabel>
                      <Select
                        aria-label={m.adaptive_period()}
                        value={state.group.granularity ?? null}
                        options={grouping.granularities.map((granularity) => ({
                          value: granularity,
                          label: periodLabel(granularity),
                        }))}
                        onValueChange={(granularity) => {
                          if (granularity && state.group)
                            changeState({
                              group: { ...state.group, granularity },
                            });
                        }}
                      />
                    </Field>
                  ) : null}
                  <Field>
                    <FieldLabel>{m.adaptive_layout()}</FieldLabel>
                    <Select
                      aria-label={m.adaptive_layout()}
                      value={state.layout}
                      options={[
                        { value: 'table', label: m.adaptive_table() },
                        ...(state.layout === 'list'
                          ? [
                              {
                                value: 'list' as const,
                                label: m.adaptive_list(),
                              },
                            ]
                          : []),
                        {
                          value: 'board',
                          label: m.adaptive_board(),
                          disabled: !state.group,
                        },
                      ]}
                      onValueChange={(layout) => {
                        if (layout) changeState({ layout });
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
                        !state.group ||
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
                            event.target.checked && state.group
                              ? [
                                  ...query.charts,
                                  {
                                    id: 'count_by_group',
                                    type: 'bar',
                                    groupBy: state.group.field,
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
                  numericFields={metricFields(query.domain, custom)}
                  label={label}
                  change={changeQuery}
                />
                {previewable(query.domain) ? null : (
                  <Alert>{m.adaptive_preview_unsupported()}</Alert>
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    !previewable(query.domain) ||
                    conditionsInvalid ||
                    preview.isFetching
                  }
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
