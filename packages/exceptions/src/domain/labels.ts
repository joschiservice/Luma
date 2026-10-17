import type { ExceptionClass } from './facts.js';

/**
 * English names of each exception class as people see them. The web localizes them by class from
 * the `issues_kind_*` catalog entries; server text such as decision explanations and record
 * labels uses these.
 */
export const exceptionClassLabels: Readonly<Record<ExceptionClass, string>> = {
  inventory_mismatch: 'Stock mismatch',
  order_quantity_mismatch: 'Quantity difference',
  stock_sync_stall: 'Stock sync stalled',
  stuck_fulfillment: 'Fulfillment delay',
  sync_failure: 'Connection issue',
  workflow_failure: 'Workflow issue',
};

/** Name for an issue whose class this version doesn't know, such as one read from older data. */
export const otherExceptionClassLabel = 'Operational issue';

const isExceptionClass = (value: string): value is ExceptionClass =>
  Object.hasOwn(exceptionClassLabels, value);

/** Returns the English name of a stored exception class, falling back for unknown classes. */
export function exceptionClassLabel(exceptionClass: string): string {
  return isExceptionClass(exceptionClass)
    ? exceptionClassLabels[exceptionClass]
    : otherExceptionClassLabel;
}
