export interface Provider {
  id: string;
  name: string;
  category: 'storefront' | 'erp';
}

export interface ProviderCatalog {
  list(category?: Provider['category']): Provider[];
  get(id: string): Provider | null;
}

/** Creates a provider catalog with category filtering and lookup by ID. */
export function createProviderCatalog(): ProviderCatalog {
  const providers: Provider[] = [
    { id: 'shopify', name: 'Shopify', category: 'storefront' },
    { id: 'jtl', name: 'JTL', category: 'erp' },
  ];
  return {
    list: (category) =>
      providers
        .filter((provider) => !category || provider.category === category)
        .map((provider) => ({ ...provider })),
    get: (id) => {
      const provider = providers.find((item) => item.id === id);
      return provider ? { ...provider } : null;
    },
  };
}
