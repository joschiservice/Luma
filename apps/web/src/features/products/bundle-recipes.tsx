import type { ProductDetail } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Card } from '@luma/ui/components/primitives/card';
import { DataTable } from '@luma/ui/components/primitives/data-table';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { Link } from '@tanstack/react-router';

import { formatSourceNumber } from '../../shared/orders/presentation';

/** Shows current source recipes without treating a merchandising parent as extra physical stock. */
export function BundleRecipes({
  detail,
  organizationId,
  sourceLabel,
  from,
}: {
  detail: ProductDetail;
  organizationId: string;
  sourceLabel: (id: string) => string;
  from: string | null;
}) {
  return (
    <Card className="products-section">
      <h2>{m.products_bundles_title()}</h2>
      <p className="products-note">{m.products_bundles_note()}</p>
      {!detail.bundles?.length ? (
        <p>{m.products_bundles_unknown()}</p>
      ) : (
        detail.bundles.map((recipe) => (
          <section key={`${recipe.connectionId}:${recipe.productId}`}>
            <h3>{sourceLabel(recipe.connectionId)}</h3>
            <p className="products-note">
              <WorkspaceDate value={recipe.observedAt} />
            </p>
            {recipe.requiresComponents || recipe.components?.length ? (
              <p>{m.products_bundles_parent()}</p>
            ) : null}
            {recipe.components === null ? (
              <p>{m.products_bundles_unknown()}</p>
            ) : (
              <DataTable
                caption={m.products_bundles_title()}
                rows={recipe.components.slice(0, 100)}
                rowKey={(component) => JSON.stringify(component.sourceId)}
                columns={[
                  {
                    key: 'component',
                    header: m.products_bundles_component(),
                    cell: (component) => (
                      <span className="products-cell">
                        {component.skuId ? (
                          <Link
                            to="/app/$organizationId/products/$skuId"
                            params={{ organizationId, skuId: component.skuId }}
                            search={{ ...(from ? { from } : {}) }}
                          >
                            {component.skuLabel ??
                              component.sourceSku?.externalId ??
                              component.sourceVariant.externalId}
                          </Link>
                        ) : (
                          <span>
                            {component.sourceSku?.externalId ??
                              component.sourceVariant.externalId}{' '}
                            · {m.common_unknown()}
                          </span>
                        )}
                        <small>
                          {component.sourceSku?.externalId ??
                            component.sourceVariant.externalId}
                        </small>
                        <small>{component.sourceId.externalId}</small>
                      </span>
                    ),
                  },
                  {
                    key: 'quantity',
                    header: m.products_bundles_quantity(),
                    numeric: true,
                    cell: (component) => formatSourceNumber(component.quantity),
                  },
                ]}
                empty={<p>{m.products_bundles_empty()}</p>}
              />
            )}
            {recipe.components && recipe.components.length > 100 ? (
              <p>{m.products_bundles_limit()}</p>
            ) : null}
          </section>
        ))
      )}
    </Card>
  );
}
