import type { CollectionDomain } from '@luma/api-contract';

/**
 * List pages that open saved views themselves, by list. Views of other lists keep opening on
 * the Views page until their list page supports views.
 */
const collectionPagePaths: Partial<Record<CollectionDomain, string>> = {
  orders: 'orders',
  fulfillment: 'fulfillment',
  products: 'products',
  inventory: 'inventory',
  transfers: 'inventory/transfers',
  customers: 'customers',
  returns: 'returns',
  issues: 'exceptions',
  decisions: 'needs-you',
  inbox: 'inbox',
  procurement: 'procurement',
  suppliers: 'procurement?tab=suppliers',
  activity: 'activity',
};

/** List pages that also show a saved view's metrics and charts above the list. */
const summaryPages = new Set<CollectionDomain>([
  'orders',
  'fulfillment',
  'products',
  'inventory',
  'customers',
  'returns',
  'procurement',
]);

/**
 * The workspace-relative URL that opens a saved view on its list page, or null while the page
 * cannot show the view: it does not open views yet, or the view has metrics or charts the page
 * does not show.
 */
export function savedViewPath(
  domain: CollectionDomain,
  viewId: string,
  summarized = false,
) {
  const path = collectionPagePaths[domain];
  if (!path || (summarized && !summaryPages.has(domain))) return null;

  return `${path}${path.includes('?') ? '&' : '?'}view=${encodeURIComponent(viewId)}`;
}
