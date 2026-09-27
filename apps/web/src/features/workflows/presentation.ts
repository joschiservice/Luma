/** Displays provider names while preserving unknown installed system identifiers. */
export function workflowSystemLabel(system: string): string {
  return (
    (
      {
        'jtl-cloud': 'JTL Cloud',
        'jtl-onprem': 'JTL-Wawi',
        shopify: 'Shopify',
        luma: 'Luma',
      } as Record<string, string>
    )[system] ?? system
  );
}

/** Gives each supported trigger an unambiguous human-readable description. */
export function workflowTriggerLabel(
  trigger: import('@luma/api-contract').WorkflowTrigger,
): string {
  switch (trigger.kind) {
    case 'manual':
      return 'Manual request';
    case 'exception':
      return `${trigger.issueType.replaceAll('_', ' ')} detected`;
    case 'event':
      return trigger.eventType;
    case 'schedule':
      return 'Scheduled start';
    case 'condition':
      return trigger.field === 'belowMinimum' && trigger.equals === true
        ? 'Stock falls below the configured minimum'
        : `${trigger.field} is ${String(trigger.equals)}`;
  }
}
