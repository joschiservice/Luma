import type {
  AdaptiveViewPreview,
  AdaptiveViewQuery,
} from '@luma/api-contract';
import { formatDate, formatDateTime, formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
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
import {
  adaptiveLabel,
  cellValue,
  columnLabel,
  recordDestination,
} from './presentation';
import { customRecordType, fieldType, viewColumns } from './query-fields';
import { ViewMetricsAndCharts } from './view-summary';

type Row = Record<string, unknown>;

/** Reads owner-provided row identities; missing identities are never made actionable. */
function adaptiveRecordId(row: Row): string | null {
  return typeof row.id === 'string'
    ? row.id
    : typeof row.entityId === 'string'
      ? row.entityId
      : null;
}

/** Names a row by its first shown column, falling back to common catalog names. */
function rowTitle(row: Row, first: string | undefined) {
  return cellValue(
    (first === undefined ? undefined : row[first]) ??
      row.number ??
      row.reference ??
      row.summary ??
      row.title ??
      row.name ??
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
  const recordType = customRecordType(configuration.domain);
  const shown = viewColumns(configuration);
  const group = configuration.state.group;
  const fields = useQuery({
    queryKey: [...adaptiveKey(organizationId), 'field-labels', recordType],
    queryFn: ({ signal }) =>
      recordType
        ? adaptiveApi.adaptiveFields.list(
            {
              params: { organizationId },
              query: { recordType, includeArchived: false },
            },
            { signal },
          )
        : [],
    enabled:
      !!recordType &&
      [...shown, group?.field ?? ''].some((column) =>
        column.startsWith('custom:'),
      ) &&
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
    if (
      fieldType(configuration.domain, key, fields.data) === 'date' &&
      typeof scalar === 'string' &&
      !Number.isNaN(Date.parse(scalar))
    )
      return formatDateTime(scalar);

    return cellValue(scalar);
  };
  // Date groups follow the view's period; weeks and months show their first day.
  const groupLabel = (row: Row) => {
    if (!group) return '';
    const scalar = row[group.field];
    if (
      !group.granularity ||
      typeof scalar !== 'string' ||
      Number.isNaN(Date.parse(scalar))
    )
      return value(row, group.field);
    const date = new Date(scalar);
    if (group.granularity === 'week')
      date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    if (group.granularity === 'month') date.setDate(1);

    return group.granularity === 'month'
      ? formatDate(date, { month: 'long', year: 'numeric' })
      : formatDate(date);
  };
  const groups = new Map<string, Row[]>();
  if (group)
    for (const row of preview.items) {
      const label = groupLabel(row);
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
  const columns = shown.map((field, index) => ({
    key: field,
    header: header(field),
    hideOnNarrow: index >= 2,
    cell: (row: Row) => {
      const text = preview.availableColumns.includes(field)
        ? value(row, field)
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
            aria-label={m.adaptive_select_record({
              record: rowTitle(row, shown[0]),
            })}
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
      rowHeader={shown[0]}
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
      <ViewMetricsAndCharts
        configuration={configuration}
        preview={preview}
        header={header}
      />
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
      {group && groups.size ? (
        configuration.state.layout === 'board' ? (
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
                      {rowLink(row, rowTitle(row, shown[0]))}
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
