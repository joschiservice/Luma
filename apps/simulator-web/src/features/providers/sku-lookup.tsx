import type { RunDetail, SkuComparison } from '@luma/simulator-contract';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  DataTable,
  type DataTableColumn,
} from '@luma/ui/components/primitives/data-table';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { useEffect, useId, useState } from 'react';

import { LoadError, Loading } from '../../components/query-state';
import { formatCount } from '../../lib/format';
import { useSku, useSkuSearch } from '../../queries';

interface StockRow {
  key: string;
  system: string;
  location: string;
  onHand: number;
  reserved: number;
  available: number;
  drift: number | null | 'erp';
}

/** Describes a shop's drift from ERP availability in words. */
export function driftText(drift: number | null) {
  if (drift === null) return 'Not comparable';
  if (drift === 0) return 'In sync';

  return drift > 0
    ? `Shop shows ${formatCount(drift)} more`
    : `Shop shows ${formatCount(-drift)} fewer`;
}

/** Rows comparing ERP stock with each shop location. */
function stockRows(comparison: SkuComparison): StockRow[] {
  return [
    ...(comparison.erp
      ? [
          {
            key: 'erp',
            system: `${comparison.erp.instance} (ERP)`,
            location: 'All warehouses',
            onHand: comparison.erp.total,
            reserved: comparison.erp.reserved,
            available: comparison.erp.available,
            drift: 'erp' as const,
          },
        ]
      : []),
    ...comparison.shops.map((shop) => ({
      key: `${shop.instance}:${shop.location}`,
      system: shop.instance,
      location: shop.location,
      onHand: shop.onHand,
      reserved: shop.committed,
      available: shop.available,
      drift: shop.drift,
    })),
  ];
}

const columns: DataTableColumn<StockRow>[] = [
  { key: 'system', header: 'System', cell: (row) => row.system },
  {
    key: 'location',
    header: 'Location',
    hideOnNarrow: true,
    cell: (row) => row.location,
  },
  {
    key: 'on-hand',
    header: 'On hand',
    numeric: true,
    cell: (row) => formatCount(row.onHand),
  },
  {
    key: 'reserved',
    header: 'Reserved or committed',
    numeric: true,
    hideOnNarrow: true,
    cell: (row) => formatCount(row.reserved),
  },
  {
    key: 'available',
    header: 'Available',
    numeric: true,
    cell: (row) => formatCount(row.available),
  },
  {
    key: 'drift',
    header: 'Against ERP',
    cell: (row) =>
      row.drift === 'erp' ? (
        <span className="sim-muted">Reference</span>
      ) : (
        <Badge
          tone={
            row.drift === 0
              ? 'success'
              : row.drift === null
                ? 'neutral'
                : 'warning'
          }
        >
          {driftText(row.drift)}
        </Badge>
      ),
  },
];

/** Finds a SKU by prefix and compares ERP availability with each shop's. */
export function SkuLookup({ run }: { run: RunDetail }) {
  const id = useId();
  const [text, setText] = useState('');
  const [prefix, setPrefix] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setPrefix(text.trim()), 300);

    return () => window.clearTimeout(timer);
  }, [text]);
  const matches = useSkuSearch(run.id, prefix);
  const comparison = useSku(run.id, selected);

  return (
    <Card as="section" aria-labelledby={`${id}-title`}>
      <CardHeader>
        <div>
          <CardTitle id={`${id}-title`}>Stock by SKU</CardTitle>
          <CardDescription>
            ERP availability next to each shop’s, with drift highlighted.
          </CardDescription>
        </div>
      </CardHeader>
      <Field>
        <FieldLabel htmlFor={`${id}-search`}>SKU</FieldLabel>
        <Input
          id={`${id}-search`}
          type="search"
          value={text}
          autoComplete="off"
          spellCheck={false}
          placeholder="Start typing a SKU"
          aria-describedby={`${id}-hint`}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <FieldDescription id={`${id}-hint`}>
          Matches SKUs that start with the text; up to 20 results.
        </FieldDescription>
      </Field>
      {prefix ? (
        <div aria-live="polite">
          {matches.isError ? (
            <LoadError title="Search failed" error={matches.error} />
          ) : matches.data && matches.data.length === 0 ? (
            <p className="sim-muted">No SKU starts with “{prefix}”.</p>
          ) : matches.data ? (
            <ul className="sim-chips" aria-label="Matching SKUs">
              {matches.data.map((match) => (
                <li key={match.sku}>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-pressed={selected === match.sku}
                    onClick={() => setSelected(match.sku)}
                  >
                    <code>{match.sku}</code>
                    <span className="sim-muted">{match.name}</span>
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {selected === null ? null : comparison.isPending ? (
        <Loading label={`Loading stock for ${selected}`} />
      ) : comparison.isError ? (
        <LoadError
          title={`Stock for ${selected} unavailable`}
          error={comparison.error}
          onRetry={() => void comparison.refetch()}
        />
      ) : (
        <div className="sim-stack-tight">
          <h4 className="sim-subtitle">
            <code>{comparison.data.sku}</code> {comparison.data.name}
          </h4>
          {comparison.data.erp === null ? (
            <p className="sim-muted">The ERP has no item for this SKU.</p>
          ) : null}
          <DataTable
            caption={`Stock for ${comparison.data.sku}`}
            columns={columns}
            rows={stockRows(comparison.data)}
            rowKey={(row) => row.key}
            density="compact"
            variant="plain"
          />
          {comparison.data.erp &&
          Object.keys(comparison.data.erp.warehouses).length > 0 ? (
            <p className="sim-note">
              Warehouses:{' '}
              {Object.entries(comparison.data.erp.warehouses)
                .map(
                  ([warehouse, quantity]) =>
                    `${warehouse} ${formatCount(quantity)}`,
                )
                .join(' · ')}
            </p>
          ) : null}
          {comparison.data.incidents.length > 0 ? (
            <p className="sim-note">
              Incidents affecting this SKU:{' '}
              {comparison.data.incidents.join(', ')}
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}
