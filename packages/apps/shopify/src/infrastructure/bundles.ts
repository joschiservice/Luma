import type { ProductBundle } from '@luma/connections';
import { productBundleSchema } from '@luma/connections/composition';
import { fail, parse } from '@luma/connector-shopify';
import {
  pageInfo,
  productVariantComponent,
} from '@luma/connector-shopify/schemas';
import { z } from 'zod';

const component = productVariantComponent;
const nodeSchema = z
  .object({
    productVariantComponents: z.object({ nodes: z.array(component), pageInfo }),
  })
  .nullable();
const ref = (externalId: string) => ({ externalId, scopeKey: '' });

/** Reads exact recipes in bounded batches and drains every child page. A disappearing parent stays unknown. */
export function createBundleReader(
  request: (
    query: string,
    variables: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>,
) {
  return async (
    variants: {
      id: string;
      requiresComponents?: boolean | undefined;
      productVariantComponents?:
        | {
            nodes: z.infer<typeof component>[];
            pageInfo: z.infer<typeof pageInfo>;
          }
        | undefined;
    }[],
  ): Promise<Map<string, ProductBundle>> => {
    const result = new Map<string, ProductBundle>();
    let edges = 0;
    const account = (amount: number) => {
      edges += amount;
      if (edges > 5000) fail('invalid_response');
    };
    const finish = (
      variant: { id: string; requiresComponents?: boolean | undefined },
      components: z.infer<typeof component>[],
    ) =>
      result.set(
        variant.id,
        parse<ProductBundle>(productBundleSchema, {
          variant: ref(variant.id),
          requiresComponents: variant.requiresComponents === true,
          components: components.map((value) => ({
            id: ref(value.id),
            variant: ref(value.productVariant.id),
            sku: value.productVariant.inventoryItem
              ? ref(value.productVariant.inventoryItem.id)
              : null,
            quantity: String(value.quantity),
          })),
        }),
      );
    for (let start = 0; start < variants.length; start += 10) {
      account(
        variants
          .slice(start, start + 10)
          .reduce(
            (sum, variant) =>
              sum + (variant.productVariantComponents?.nodes.length ?? 0),
            0,
          ),
      );
      const pending = variants
        .slice(start, start + 10)
        .filter((variant) => variant.requiresComponents !== undefined)
        .filter((variant) => {
          if (
            variant.productVariantComponents &&
            !variant.productVariantComponents.pageInfo.hasNextPage
          ) {
            finish(variant, variant.productVariantComponents.nodes);

            return false;
          }
          if (
            variant.productVariantComponents &&
            (!variant.productVariantComponents.pageInfo.endCursor ||
              !variant.productVariantComponents.nodes.length)
          )
            fail('invalid_response');

          return true;
        })
        .map((variant) => ({
          variant,
          after: variant.productVariantComponents?.pageInfo.endCursor ?? null,
          components: [...(variant.productVariantComponents?.nodes ?? [])],
          seen: new Set<string>(
            variant.productVariantComponents?.pageInfo.endCursor
              ? [variant.productVariantComponents.pageInfo.endCursor]
              : [],
          ),
        }));
      while (pending.length) {
        const variables: Record<string, unknown> = {};
        const declarations: string[] = [],
          fields: string[] = [];
        for (const [index, item] of pending.entries()) {
          declarations.push(`$id${index}: ID!`, `$after${index}: String`);
          variables[`id${index}`] = item.variant.id;
          variables[`after${index}`] = item.after;
          fields.push(
            `v${index}: node(id: $id${index}) { ... on ProductVariant { productVariantComponents(first: 10, after: $after${index}) { nodes { id quantity productVariant { id inventoryItem { id } } } pageInfo { hasNextPage endCursor } } } }`,
          );
        }
        const data = await request(
          `query LumaBundleRecipes(${declarations.join(',')}) { ${fields.join('\n')} }`,
          variables,
        );
        const completed: number[] = [];
        for (const [index, item] of pending.entries()) {
          const node = parse(nodeSchema, data[`v${index}`]);
          if (!node) {
            result.set(item.variant.id, {
              variant: ref(item.variant.id),
              requiresComponents: item.variant.requiresComponents === true,
              components: null,
            });
            completed.push(index);
            continue;
          }
          account(node.productVariantComponents.nodes.length);
          item.components.push(...node.productVariantComponents.nodes);
          if (item.components.length > 5000) fail('invalid_response');
          const page = node.productVariantComponents.pageInfo;
          if (!page.hasNextPage) {
            finish(item.variant, item.components);
            completed.push(index);
          } else {
            if (
              !node.productVariantComponents.nodes.length ||
              !page.endCursor ||
              item.seen.has(page.endCursor) ||
              item.components.length >= 5000
            )
              fail('invalid_response');
            item.seen.add(page.endCursor);
            item.after = page.endCursor;
          }
        }
        for (const index of completed.reverse()) pending.splice(index, 1);
      }
    }

    return result;
  };
}
