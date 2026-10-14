import type { CollectionColumn, CollectionWhere } from '@luma/api-contract';

import type {
  ConditionField,
  ConditionWhere,
} from '../../lib/collection-conditions';
import type { DataTableColumnState } from '../../lib/column-state';
import type { DisplayColumn } from './collection-display';

/** Order fields as the orders page would describe them, with English labels for stories. */
export const orderFields: ConditionField[] = [
  {
    id: 'status',
    label: 'Status',
    group: 'Order',
    type: 'enum',
    operators: ['any_of', 'none_of', 'empty', 'not_empty'],
    options: [
      { value: 'open', label: 'Open' },
      { value: 'completed', label: 'Completed' },
      { value: 'cancelled', label: 'Cancelled' },
      { value: 'unknown', label: 'Unknown' },
    ],
  },
  {
    id: 'placed',
    label: 'Placed',
    group: 'Order',
    type: 'date',
    operators: [
      'before',
      'after',
      'between',
      'within_last',
      'within_next',
      'empty',
      'not_empty',
    ],
  },
  {
    id: 'total',
    label: 'Total',
    group: 'Payment',
    type: 'money',
    operators: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'empty'],
    currencies: ['EUR', 'USD', 'GBP'],
  },
  {
    id: 'lineCount',
    label: 'Lines',
    group: 'Order',
    type: 'number',
    operators: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'],
  },
  {
    id: 'available',
    label: 'Available stock',
    group: 'Inventory',
    type: 'number',
    operators: ['lt', 'lte', 'gt', 'gte', 'eq'],
    perSource: true,
    sources: [
      { value: '0d4f6a52-6a41-4b7e-9d0e-3f0f0f0f0f01', label: 'Tokyo store' },
      { value: '0d4f6a52-6a41-4b7e-9d0e-3f0f0f0f0f02', label: 'JTL-Wawi' },
    ],
  },
  {
    id: 'assignee',
    label: 'Assignee',
    group: 'Work',
    type: 'person',
    operators: ['any_of', 'none_of', 'empty'],
    offerMe: true,
    options: [
      { value: 'u1', label: 'Mara Lind' },
      { value: 'u2', label: 'Jonas Weber' },
    ],
  },
  {
    id: 'overdue',
    label: 'Overdue',
    group: 'Work',
    type: 'boolean',
    operators: ['is'],
  },
  {
    id: 'number',
    label: 'Order number',
    group: 'Order',
    type: 'text',
    operators: ['contains', 'not_contains', 'is', 'is_not'],
  },
  {
    id: 'warehouse',
    label: 'Warehouse',
    group: 'Fulfillment',
    type: 'reference',
    operators: ['any_of', 'none_of'],
    unavailable: 'Your role cannot see fulfillment.',
  },
];

/** Thirty generated custom fields, for long, grouped field lists. */
export const manyFields: ConditionField[] = [
  ...orderFields,
  ...Array.from({ length: 30 }, (_, index) => ({
    id: `custom${index + 1}`,
    label: `Custom field ${index + 1}`,
    group: 'Custom fields',
    type: 'text' as const,
    operators: ['contains', 'is', 'empty'] as const,
  })),
];

/** Columns of the orders table for the display menu. */
export const orderColumns: DisplayColumn[] = [
  {
    key: 'number',
    label: 'Order',
    description: 'The order number in its source.',
    group: 'Order',
    origin: 'source',
    required: true,
  },
  {
    key: 'status',
    label: 'Status',
    description: 'Open, completed or cancelled.',
    group: 'Order',
    origin: 'source',
  },
  {
    key: 'fulfillment',
    label: 'Fulfillment',
    description: 'How much of the order has shipped.',
    group: 'Fulfillment',
    origin: 'derived',
  },
  {
    key: 'total',
    label: 'Total',
    description: 'Order total in its currency.',
    group: 'Payment',
    origin: 'source',
  },
  {
    key: 'paymentStatus',
    label: 'Payment status',
    description: 'Reported by the shop.',
    group: 'Payment',
    origin: 'source',
  },
  {
    key: 'comparison',
    label: 'Comparison',
    description: 'Whether sources agree on the order.',
    group: 'Checks',
    origin: 'luma',
  },
  {
    key: 'warehouse',
    label: 'Warehouse',
    description: 'Where the order ships from.',
    group: 'Fulfillment',
    origin: 'source',
    unavailable: 'Your role cannot see fulfillment.',
  },
  {
    key: 'legacyChannel',
    label: 'Sales channel (archived)',
    group: 'Order',
    origin: 'source',
    unavailable: 'This custom field was archived.',
  },
];

/** The list API's state shapes are accepted as they are. */
const contractWhere: CollectionWhere = {
  match: 'all',
  conditions: [
    { field: 'status', op: 'any_of', value: ['open', 'completed'] },
    { field: 'placed', op: 'within_last', value: { amount: 30, unit: 'day' } },
  ],
};

export const storyWhere: ConditionWhere = contractWhere;

const contractColumns: CollectionColumn[] = [
  { id: 'number', width: 160 },
  { id: 'status' },
  { id: 'total', width: 140 },
];

export const storyColumnState: DataTableColumnState = {
  columns: contractColumns.map((column) => ({
    key: column.id,
    width: column.width,
  })),
};
