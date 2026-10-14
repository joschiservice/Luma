import './adaptive.css';

import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';

import type { CollectionView } from '../../kit/collections/use-collection-view';
import { previewOptions } from './data';
import { columnLabel } from './presentation';
import { ViewMetricsAndCharts } from './view-summary';

const collapsedKey = '@summary';

/**
 * Shows the open saved view's metrics and charts above a list page, over the view as the page
 * shows it now. Aggregates read the complete filtered query within the saved-view read bound;
 * a query that is too broad says so instead of totalling one page. Members can collapse the
 * band; that choice is their own display setting.
 */
export function CollectionSummaryBand({
  organizationId,
  view,
}: {
  organizationId: string;
  view: CollectionView;
}) {
  const saved = view.saved;
  const configured =
    !!saved?.query.metrics.length || !!saved?.query.charts.length;
  const collapsed = view.display.collapsedGroups.includes(collapsedKey);
  const summary = useQuery({
    ...previewOptions(organizationId, {
      ...(saved?.query ?? {
        version: 2,
        domain: view.domain,
        metrics: [],
        charts: [],
        actions: [],
      }),
      state: view.state,
    }),
    enabled: configured && !collapsed,
  });
  if (!saved || !configured) return null;
  const toggle = () =>
    view.setDisplay({
      ...view.display,
      collapsedGroups: collapsed
        ? view.display.collapsedGroups.filter((key) => key !== collapsedKey)
        : [...view.display.collapsedGroups, collapsedKey],
    });

  return (
    <section
      className="collection-summary-band"
      aria-label={m.collections_summary_label()}
    >
      <Button variant="ghost" aria-expanded={!collapsed} onClick={toggle}>
        {collapsed ? (
          <ChevronRight aria-hidden="true" />
        ) : (
          <ChevronDown aria-hidden="true" />
        )}
        {m.collections_summary_label()}
      </Button>
      {collapsed ? null : summary.isError ? (
        <Alert tone="warning" role="status">
          {m.collections_summary_unavailable()}
        </Alert>
      ) : summary.data ? (
        <ViewMetricsAndCharts
          configuration={saved.query}
          preview={summary.data}
          header={columnLabel}
        />
      ) : (
        <p role="status">{m.collections_summary_loading()}</p>
      )}
    </section>
  );
}
