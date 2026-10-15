import { recordKindSchema } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

/** Selects a tenant record by its readable label; searches never establish execution authority. */
export function WorkflowSubjectPicker({
  organizationId,
  kind,
  value,
  onChange,
}: {
  organizationId: string;
  kind: string;
  value: string;
  onChange(value: string): void;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<{ value: string; label: string }>();
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);

    return () => clearTimeout(timer);
  }, [search]);
  const records = useQuery({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'workflow-subjects',
      kind,
      query,
    ],
    queryFn: async ({ signal }) => {
      const params = { organizationId };
      if (kind === 'purchase_order') {
        const result = await api.procurement.orders(
          { params, query: { q: query, limit: 50 } },
          { signal },
        );

        return result.items.map((item) => ({
          value: item.id,
          label: `${item.reference} · ${item.supplierName}`,
        }));
      }
      if (kind === 'supplier') {
        const result = await api.procurement.suppliers(
          { params, query: { q: query, limit: 50 } },
          { signal },
        );

        return result.items.map((item) => ({
          value: item.id,
          label: item.name,
        }));
      }
      if (kind === 'connection') {
        const result = await api.connections.list({ params }, { signal });

        return result.items
          .filter((item) =>
            item.label.toLowerCase().includes(query.toLowerCase()),
          )
          .map((item) => ({ value: item.id, label: item.label }));
      }
      const parsed = recordKindSchema.safeParse(
        kind === 'inventory_position' || kind === 'stock_position'
          ? 'position'
          : kind,
      );
      if (!parsed.success) return [];
      const result = await api.records.list(
        { params, query: { kind: parsed.data, q: query } },
        { signal },
      );

      return result.items.map((item) => ({
        value: item.id,
        label: item.label,
      }));
    },
  });
  const choices = [
    ...new Map(
      [
        ...(selected?.value === value ? [selected] : []),
        ...(records.data ?? []),
      ].map((item) => [item.value, item]),
    ).values(),
  ];

  return (
    <div className="workflow-subject-picker">
      <Input
        aria-label={m.workflows_record_search()}
        placeholder={m.workflows_record_search()}
        value={search}
        maxLength={120}
        onChange={(event) => setSearch(event.target.value)}
      />
      <Select
        aria-label={m.workflows_record_select()}
        value={value}
        options={choices}
        disabled={records.isPending}
        onValueChange={(next) => {
          if (!next) return;
          setSelected(choices.find((item) => item.value === next));
          onChange(next);
        }}
      />
      {records.isError ? (
        <p role="alert">{m.workflows_record_load_failed()}</p>
      ) : null}
      {records.data?.length === 0 ? (
        <p role="status">{m.workflows_record_none()}</p>
      ) : null}
    </div>
  );
}
