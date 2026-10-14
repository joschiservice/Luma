import type { AdaptiveViewQuery } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Select } from '@luma/ui/components/primitives/select';
import { Trash2 } from 'lucide-react';

import { ActionMappings } from './action-mappings';

/** Edits numeric metrics and the explicitly bound action configuration. */
export function QueryExtras({
  organizationId,
  query,
  numericFields,
  label,
  change,
}: {
  organizationId: string;
  query: AdaptiveViewQuery;
  /** Catalog and custom number fields the view can sum or average. */
  numericFields: readonly string[];
  label: (field: string) => string;
  change: (query: AdaptiveViewQuery) => void;
}) {
  return (
    <>
      {numericFields.length ||
      query.metrics.some((metric) => metric.operation !== 'count') ? (
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
                    options={[
                      ...new Set([
                        ...numericFields,
                        ...(metric.field ? [metric.field] : []),
                      ]),
                    ].map((field) => ({ value: field, label: label(field) }))}
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
            disabled={query.metrics.length >= 8 || !numericFields.length}
            onClick={() => {
              const field = numericFields[0];
              if (field)
                change({
                  ...query,
                  metrics: [
                    ...query.metrics,
                    {
                      id: `metric_${crypto.randomUUID().slice(0, 8)}`,
                      operation: 'sum',
                      field,
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
        label={label}
        change={change}
      />
    </>
  );
}
