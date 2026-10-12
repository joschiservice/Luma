import type { ExternalId } from './capabilities.js';

/** Merchandising context for exact component lines. It is not another fulfillable or stock line. */
export interface OrderBundleGroup {
  id: ExternalId;
  title: string;
  quantity: string;
  product: ExternalId | null;
  variant: ExternalId | null;
  skuCode: string | null;
}

/** Source recipe for one parent variant; unknown collections never become an empty recipe. */
export interface ProductBundle {
  variant: ExternalId;
  requiresComponents: boolean;
  components:
    | {
        id: ExternalId;
        variant: ExternalId;
        sku: ExternalId | null;
        quantity: string;
      }[]
    | null;
}
