import type {
  AdaptiveViewPreview,
  AdaptiveViewQuery,
} from '@luma/api-contract';
import { formatDateTime, formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { BarChart } from '@luma/ui/components/primitives/bar-chart';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  DataTable,
  DataTableRowLink,
} from '@luma/ui/components/primitives/data-table';
import { Empty } from '@luma/ui/components/primitives/empty';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useQuery } from '@tanstack/react-query';

import { usePermissions } from '../../kit/identity/permissions';
import { adaptiveApi, adaptiveAvailabilityOptions, adaptiveKey } from './data';
import { LinePlot } from './line-plot';
import {
  adaptiveLabel,
  cellValue,
  columnLabel,
  recordDestination,
} from './presentation';

type Row = Record<string, unknown>;

/** Reads owner-provided row identities; missing identities are never made actionable. */
function adaptiveRecordId(row: Row): string | null {
  return typeof row.id === 'string'
    ? row.id
    : typeof row.entityId === 'string'
      ? row.entityId
      : null;
}

function rowTitle(row: Row) {
  return cellValue(
    row.displayNumber ??
      row.reference ??
      row.summary ??
      row.title ??
      row.displayName ??
      row.sku ??
      row.id,
  );
}

/** Presents bounded owner reads, grouping, charts and separate incomplete evidence warnings. */
export function AdaptiveRecords({
  organizationId,
  configuration,
  preview,
  selected,
  onSelected,
  onNext,
  onFirst,
}: {
  organizationId: string;
  configuration: AdaptiveViewQuery;
  preview: AdaptiveViewPreview;
  selected?: readonly string[];
  onSelected?: (ids: string[]) => void;
  onNext?: (() => void) | undefined;
  onFirst?: (() => void) | undefined;
}) {
  const { can } = usePermissions(organizationId);
  const availability = useQuery(adaptiveAvailabilityOptions(organizationId));
  const recordType =
    configuration.domain === 'orders'
      ? 'order'
      : configuration.domain === 'products'
        ? 'product'
        : 'purchase_order';
  const fields = useQuery({
    queryKey: [...adaptiveKey(organizationId), 'field-labels', recordType],
    queryFn: ({ signal }) =>
      adaptiveApi.adaptiveFields.list(
        {
          params: { organizationId },
          query: { recordType, includeArchived: false },
        },
        { signal },
      ),
    enabled:
      configuration.columns.some((column) => column.startsWith('custom:')) &&
      ['orders', 'products', 'procurement'].includes(configuration.domain) &&
      can('adaptive.fields.read') &&
      availability.data?.fields === true,
  });
  const header = (key: string) => {
    if (!key.startsWith('custom:')) return columnLabel(key);
    const definition = fields.data?.find(
      (field) => `custom:${field.id}` === key,
    );

    return definition
      ? adaptiveLabel(definition.label)
      : m.adaptive_unavailable_field();
  };
  const value = (row: Row, key: string) => {
    const definition = fields.data?.find(
      (field) => `custom:${field.id}` === key,
    );
    const scalar = row[key];
    if (definition?.type === 'single_choice' && typeof scalar === 'string') {
      const choice = definition.choices.find((item) => item.key === scalar);

      return choice ? adaptiveLabel(choice.label) : m.adaptive_unknown();
    }

    return cellValue(scalar);
  };
  const groups = new Map<string, Row[]>();
  if (configuration.groupBy)
    for (const row of preview.items) {
      const label = cellValue(row[configuration.groupBy]);
      groups.set(label, [...(groups.get(label) ?? []), row]);
    }
  const rowLink = (row: Row, text: string) => {
    const href = recordDestination(organizationId, configuration.domain, row);

    return href ? (
      <DataTableRowLink href={href}>{text}</DataTableRowLink>
    ) : (
      text
    );
  };
  const columns = configuration.columns.map((field, index) => ({
    key: field,
    header: header(field),
    hideOnNarrow: index >= 2,
    cell: (row: Row) => {
      const available = preview.availableColumns.includes(field);
      const text = available
        ? field.endsWith('At') &&
          typeof row[field] === 'string' &&
          !Number.isNaN(Date.parse(row[field]))
          ? formatDateTime(row[field])
          : value(row, field)
        : m.adaptive_unavailable_field();

      return index === 0 ? rowLink(row, text) : text;
    },
  }));
  if (onSelected)
    columns.unshift({
      key: '__selection',
      hideOnNarrow: false,
      header: m.adaptive_selected({ count: selected?.length ?? 0 }),
      cell: (row: Row) => {
        const id = adaptiveRecordId(row);

        return (
          <input
            type="checkbox"
            aria-label={m.adaptive_select_record({ record: rowTitle(row) })}
            disabled={!id}
            checked={!!id && !!selected?.includes(id)}
            onChange={(event) => {
              if (!id) return;
              onSelected(
                event.target.checked
                  ? [...(selected ?? []), id]
                  : (selected ?? []).filter((item) => item !== id),
              );
            }}
          />
        );
      },
    });
  const table = (rows: Row[], caption: string) => (
    <DataTable
      caption={caption}
      rows={rows}
      columns={columns}
      rowHeader={configuration.columns[0]}
      rowKey={(row) => adaptiveRecordId(row) ?? JSON.stringify(row)}
      empty={
        <Empty>
          <p>{m.adaptive_records_empty()}</p>
        </Empty>
      }
    />
  );

  return (
    <div className="adaptive-preview">
      <div className="adaptive-preview-meta">
        <span>{m.adaptive_page_count({ count: preview.items.length })}</span>
        <span>
          <WorkspaceDate value={preview.asOf} />
        </span>
        {preview.warnings.length ? (
          <Badge tone="warning">{m.overview_coverage_partial()}</Badge>
        ) : null}
      </div>
      {preview.warnings.map((warning) => (
        <Alert key={warning} tone="warning">
          {warning}
        </Alert>
      ))}
      {configuration.metrics.length ? (
        <div className="adaptive-metrics">
          {configuration.metrics.map((metric) => {
            const aggregate = preview.aggregates.find(
              (item) => item.metricId === metric.id,
            );

            return (
              <div className="adaptive-metric" key={metric.id}>
                <span>{columnLabel(metric.id)}</span>
                <strong>
                  {aggregate?.value === null || !aggregate
                    ? m.adaptive_unknown()
                    : formatNumber(aggregate.value)}
                </strong>
                {!aggregate?.complete ? (
                  <span>{m.overview_coverage_partial()}</span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {configuration.charts.map((chart) => {
        const series = preview.chartSeries.find((item) => item.id === chart.id);
        const categories = (series?.points ?? []).map((point, index) => ({
          key: String(index),
          label: cellValue(point.key),
          values: { count: point.value ?? 0 },
          ...(point.value === null ? { unknown: m.adaptive_unknown() } : {}),
          ...(!series?.complete ? { note: m.overview_coverage_partial() } : {}),
        }));

        return (
          <Card key={chart.id}>
            <CardHeader>
              <CardTitle as="h3">{columnLabel(chart.id)}</CardTitle>
              <p>
                {series?.truncated
                  ? m.adaptive_chart_truncated()
                  : !series?.complete
                    ? m.overview_coverage_partial()
                    : m.adaptive_chart_complete()}
              </p>
            </CardHeader>
            <CardContent>
              {chart.type === 'line' ? (
                <LinePlot points={categories} label={columnLabel(chart.id)} />
              ) : (
                <BarChart
                  label={columnLabel(chart.id)}
                  orientation="horizontal"
                  series={[
                    {
                      id: 'count',
                      label: columnLabel(chart.metricId),
                      color: 'chart-1',
                    },
                  ]}
                  categories={categories}
                />
              )}
              <DataTable
                caption={columnLabel(chart.id)}
                density="compact"
                variant="plain"
                rows={categories}
                rowKey={(row) => row.key}
                columns={[
                  {
                    key: 'label',
                    header: columnLabel(chart.groupBy),
                    cell: (row) => row.label,
                  },
                  {
                    key: 'count',
                    header: columnLabel(chart.metricId),
                    numeric: true,
                    cell: (row) =>
                      row.unknown
                        ? m.adaptive_unknown()
                        : formatNumber(row.values.count),
                  },
                ]}
              />
            </CardContent>
          </Card>
        );
      })}
      {onSelected && preview.items.length ? (
        <label className="adaptive-check">
          <input
            type="checkbox"
            aria-label={m.adaptive_select_all()}
            checked={preview.items.every((row) => {
              const id = adaptiveRecordId(row);

              return !!id && !!selected?.includes(id);
            })}
            onChange={(event) =>
              onSelected(
                event.target.checked
                  ? preview.items.flatMap((row) => {
                      const id = adaptiveRecordId(row);

                      return id ? [id] : [];
                    })
                  : [],
              )
            }
          />
          {m.adaptive_select_all()}
        </label>
      ) : null}
      {configuration.groupBy && groups.size ? (
        configuration.layout === 'board' ? (
          <div className="adaptive-board">
            {[...groups].map(([label, rows]) => (
              <Card key={label}>
                <CardHeader>
                  <CardTitle as="h3">
                    {label} <Badge>{formatNumber(rows.length)}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent className="adaptive-board-rows">
                  {rows.map((row) => (
                    <div
                      className="adaptive-board-row"
                      key={adaptiveRecordId(row) ?? JSON.stringify(row)}
                    >
                      {rowLink(row, rowTitle(row))}
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          [...groups].map(([label, rows]) => (
            <section key={label}>
              <h3>
                {label} <Badge>{formatNumber(rows.length)}</Badge>
              </h3>
              {table(rows, label)}
            </section>
          ))
        )
      ) : (
        table(preview.items, m.adaptive_matching())
      )}
      {onNext || onFirst ? (
        <div className="adaptive-pagination">
          {onFirst ? (
            <Button variant="outline" onClick={onFirst}>
              {m.adaptive_first()}
            </Button>
          ) : null}
          {preview.nextCursor && onNext ? (
            <Button variant="outline" onClick={onNext}>
              {m.adaptive_next()}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
