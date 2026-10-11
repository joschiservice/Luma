import type { WorkflowTrigger } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';

/** Displays provider names while preserving unknown installed system identifiers. */
export function workflowSystemLabel(system: string): string {
  return (
    (
      {
        'jtl-cloud': 'JTL Cloud',
        'jtl-onprem': 'JTL-Wawi',
        'cin7-core': 'Cin7 Core',
        shopify: 'Shopify',
        luma: 'Luma',
      } as Record<string, string>
    )[system] ?? system
  );
}

/** Gives each supported trigger an unambiguous human-readable description. */
export function workflowTriggerLabel(trigger: WorkflowTrigger): string {
  switch (trigger.kind) {
    case 'manual':
      return m.workflows_trigger_manual();
    case 'exception':
      return m.workflows_trigger_issue_detected({
        issue: trigger.issueType.replaceAll('_', ' '),
      });
    case 'event':
      return trigger.eventType;
    case 'schedule':
      return m.workflows_trigger_schedule();
    case 'condition':
      return trigger.field === 'belowMinimum' && trigger.equals === true
        ? m.workflows_trigger_below_minimum()
        : m.workflows_trigger_condition({
            field: trigger.field,
            value: String(trigger.equals),
          });
  }
}

/** Names a workflow's operational area; resolution workflows fix detected issues. */
export function workflowCategoryLabel(category: string): string {
  if (category === 'resolution') return m.workflows_category_resolution();
  if (category === 'procurement') return m.workflows_category_procurement();

  return category.charAt(0).toUpperCase() + category.slice(1);
}
