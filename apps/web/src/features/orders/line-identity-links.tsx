import type { OrderDetail } from '@luma/api-contract';
import { formatList } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useId, useState } from 'react';

import { IdentityLinks } from '../sync/identity-links';

/**
 * Lets an operator explicitly match current lines of an already linked order, retaining each
 * source's quantities. `initialLineId` opens with that line chosen.
 */
export function OrderLineIdentityLinks({
  organizationId,
  detail,
  initialLineId,
}: {
  organizationId: string;
  detail: OrderDetail;
  initialLineId?: string | undefined;
}) {
  const client = useQueryClient();
  const id = useId();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(
    initialLineId ?? null,
  );
  const changed = useCallback(() => {
    void client.invalidateQueries({
      queryKey: ['private', 'organization', organizationId],
    });
  }, [client, organizationId]);
  const lines = new Map<
    string,
    { title: string; sources: Set<string>; terms: string[] }
  >();
  for (const source of detail.sources) {
    for (const line of source.lines) {
      const existing = lines.get(line.id);
      const terms = [line.id, line.title, line.skuCode, source.label].filter(
        (value): value is string => value !== null,
      );
      if (existing) {
        existing.sources.add(source.label);
        existing.terms.push(...terms);
      } else {
        lines.set(line.id, {
          title:
            line.title ??
            line.skuCode ??
            m.orders_line_links_fallback({ id: line.id.slice(0, 8) }),
          sources: new Set([source.label]),
          terms,
        });
      }
    }
  }
  if (detail.sources.length < 2 || !lines.size) return null;
  const query = search.trim().toLocaleLowerCase();
  const matches = [...lines.entries()].filter(([, line]) =>
    line.terms.some((term) => term.toLocaleLowerCase().includes(query)),
  );
  const options = matches.slice(0, 100).map(([value, line]) => ({
    value,
    label: `${line.title} · ${formatList([...line.sources])} · ${value.slice(0, 8)}`,
  }));
  const selected = selectedId && lines.has(selectedId) ? selectedId : null;
  if (selected && !options.some((option) => option.value === selected)) {
    const line = lines.get(selected);
    if (line)
      options.push({
        value: selected,
        label: `${line.title} · ${formatList([...line.sources])} · ${selected.slice(0, 8)}`,
      });
  }

  return (
    <section className="orders-line-links" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{m.orders_line_links_title()}</h3>
      <p>{m.orders_line_links_description()}</p>
      {lines.size > 100 ? (
        <Field>
          <FieldLabel htmlFor={`${id}-search`}>
            {m.orders_line_links_search()}
          </FieldLabel>
          <Input
            id={`${id}-search`}
            value={search}
            maxLength={120}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
      ) : null}
      <Field>
        <FieldLabel htmlFor={`${id}-line`}>
          {m.orders_line_links_choose()}
        </FieldLabel>
        <Select
          id={`${id}-line`}
          aria-label={m.orders_line_links_choose()}
          placeholder={m.orders_line_links_placeholder()}
          value={selected}
          options={options}
          onValueChange={setSelectedId}
        />
      </Field>
      {matches.length > 100 ? (
        <p role="status">{m.orders_line_links_limit()}</p>
      ) : null}
      {selected ? (
        <IdentityLinks
          key={selected}
          organizationId={organizationId}
          entityId={selected}
          kind="order_line"
          onChanged={changed}
        />
      ) : null}
    </section>
  );
}
