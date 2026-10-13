import type { AdaptiveViewQuery, CustomField } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { Trash2 } from 'lucide-react';

import { ActionMappings } from './action-mappings';
import { adaptiveLabel } from './presentation';

/** Edits typed custom predicates, numeric metrics and the explicitly bound action configuration. */
export function QueryExtras({
  organizationId,
  query,
  fields,
  change,
}: {
  organizationId: string;
  query: AdaptiveViewQuery;
  fields: CustomField[];
  change: (query: AdaptiveViewQuery) => void;
}) {
  return (
    <>
      {fields.length ? (
        <section className="adaptive-editor-group">
          <h2>{m.adaptive_fields_title()}</h2>
          {query.customFilters.map((filter, index) => {
            const definition = fields.find(
              (field) => field.id === filter.fieldId,
            );
            const update = (value: Partial<typeof filter>) =>
              change({
                ...query,
                customFilters: query.customFilters.map((item, at) =>
                  at === index ? { ...item, ...value } : item,
                ),
              });

            return (
              <div
                className="adaptive-filter"
                key={`${filter.fieldId}:${index}`}
              >
                <Field>
                  <FieldLabel>
                    {definition
                      ? adaptiveLabel(definition.label)
                      : m.adaptive_unavailable_field()}
                  </FieldLabel>
                  <Select
                    aria-label={m.adaptive_filter_operator()}
                    value={filter.operator}
                    options={[
                      { value: 'eq', label: m.adaptive_equals() },
                      { value: 'ne', label: m.adaptive_not_equals() },
                      { value: 'contains', label: m.adaptive_contains() },
                      { value: 'is_empty', label: m.adaptive_is_empty() },
                      ...(definition?.type === 'number'
                        ? [
                            {
                              value: 'gt' as const,
                              label: m.adaptive_greater(),
                            },
                            { value: 'lt' as const, label: m.adaptive_less() },
                          ]
                        : []),
                    ]}
                    onValueChange={(operator) => {
                      if (operator) update({ operator });
                    }}
                  />
                </Field>
                <Field>
                  <FieldLabel>{m.adaptive_value()}</FieldLabel>
                  {definition?.type === 'boolean' ? (
                    <Select
                      aria-label={m.adaptive_value()}
                      value={filter.value === true ? 'true' : 'false'}
                      options={[
                        { value: 'true', label: m.adaptive_yes() },
                        { value: 'false', label: m.adaptive_no() },
                      ]}
                      onValueChange={(value) =>
                        update({ value: value === 'true' })
                      }
                    />
                  ) : definition?.type === 'single_choice' ? (
                    <Select
                      aria-label={m.adaptive_value()}
                      value={
                        typeof filter.value === 'string' ? filter.value : null
                      }
                      options={definition.choices.map((choice) => ({
                        value: choice.key,
                        label: adaptiveLabel(choice.label),
                      }))}
                      onValueChange={(value) => update({ value })}
                    />
                  ) : (
                    <Input
                      type={
                        definition?.type === 'number'
                          ? 'number'
                          : definition?.type === 'date'
                            ? 'date'
                            : 'text'
                      }
                      disabled={filter.operator === 'is_empty'}
                      aria-label={m.adaptive_value()}
                      value={filter.value === null ? '' : String(filter.value)}
                      onChange={(event) =>
                        update({
                          value:
                            definition?.type === 'number'
                              ? Number(event.target.value)
                              : event.target.value,
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
                  onClick={() =>
                    change({
                      ...query,
                      customFilters: query.customFilters.filter(
                        (_, at) => at !== index,
                      ),
                    })
                  }
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            );
          })}
          <Select
            aria-label={m.adaptive_add_filter()}
            value={null}
            placeholder={m.adaptive_add_filter()}
            options={fields.map((field) => ({
              value: field.id,
              label: adaptiveLabel(field.label),
            }))}
            onValueChange={(fieldId) => {
              if (fieldId)
                change({
                  ...query,
                  customFilters: [
                    ...query.customFilters,
                    { fieldId, operator: 'eq', value: null },
                  ],
                });
            }}
          />
        </section>
      ) : null}
      {fields.some((field) => field.type === 'number') ? (
        <section className="adaptive-editor-group">
          <h2>{m.adaptive_numeric_metrics()}</h2>
          {query.metrics
            .filter((metric) => metric.operation !== 'count')
            .map((metric) => (
              <div className="adaptive-filter" key={metric.id}>
                <Field>
                  <FieldLabel>{m.adaptive_field()}</FieldLabel>
                  <Select
                    aria-label={m.adaptive_field()}
                    value={metric.field}
                    options={fields
                      .filter((field) => field.type === 'number')
                      .map((field) => ({
                        value: `custom:${field.id}`,
                        label: adaptiveLabel(field.label),
                      }))}
                    onValueChange={(field) =>
                      change({
                        ...query,
                        metrics: query.metrics.map((item) =>
                          item.id === metric.id ? { ...item, field } : item,
                        ),
                      })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel>{m.adaptive_metric_operation()}</FieldLabel>
                  <Select
                    aria-label={m.adaptive_metric_operation()}
                    value={metric.operation}
                    options={[
                      { value: 'sum', label: m.adaptive_sum() },
                      { value: 'average', label: m.adaptive_average() },
                    ]}
                    onValueChange={(operation) => {
                      if (operation)
                        change({
                          ...query,
                          metrics: query.metrics.map((item) =>
                            item.id === metric.id
                              ? { ...item, operation }
                              : item,
                          ),
                        });
                    }}
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={m.adaptive_remove()}
                  onClick={() =>
                    change({
                      ...query,
                      metrics: query.metrics.filter(
                        (item) => item.id !== metric.id,
                      ),
                      charts: query.charts.filter(
                        (chart) => chart.metricId !== metric.id,
                      ),
                    })
                  }
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            ))}
          <Button
            type="button"
            variant="outline"
            disabled={query.metrics.length >= 8}
            onClick={() => {
              const field = fields.find((item) => item.type === 'number');
              if (field)
                change({
                  ...query,
                  metrics: [
                    ...query.metrics,
                    {
                      id: `metric_${crypto.randomUUID().slice(0, 8)}`,
                      operation: 'sum',
                      field: `custom:${field.id}`,
                    },
                  ],
                });
            }}
          >
            {m.adaptive_add_metric()}
          </Button>
        </section>
      ) : null}
      <ActionMappings
        organizationId={organizationId}
        query={query}
        change={change}
      />
    </>
  );
}
