import type { CatalogSource } from '@luma/api-contract';

import { systemName } from './presentation';

/** Names a catalog source column, adding the system when the label does not already say it. */
export function SourceHeader({ source }: { source: CatalogSource }) {
  const system = systemName(source.system);

  return (
    <span className="products-source-header">
      {source.label}
      {source.label.includes(system) ? null : <small>{system}</small>}
    </span>
  );
}
