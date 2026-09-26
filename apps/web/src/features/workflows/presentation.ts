/** Displays provider names while preserving unknown installed system identifiers. */
export function workflowSystemLabel(system: string): string {
  return (
    (
      {
        'jtl-cloud': 'JTL Cloud',
        'jtl-onprem': 'JTL-Wawi',
        shopify: 'Shopify',
      } as Record<string, string>
    )[system] ?? system
  );
}
