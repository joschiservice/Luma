import { activityOutcomes, activityTypes } from './activity.js';
import { caseClasses, caseStates, caseSubjectKinds } from './cases.js';
import type {
  CollectionCatalog,
  CollectionFieldDefinition,
} from './collection-catalog.js';
import { collectionOperators, ordersCatalog } from './collection-catalog.js';
import type { CollectionDomain } from './collections.js';
import {
  decisionDomains,
  decisionImpacts,
  decisionKinds,
  decisionReasons,
} from './decisions.js';
import { linkedRecordKinds, threadStatuses } from './messaging.js';

// Each list starts with the fields it can show. Filters, sorts and groups are added to a field
// once the list's API implements them, so the catalog never promises what the server refuses.
const choice = ['any_of', 'none_of', 'empty', 'not_empty'] as const;
const dates = ['day', 'week', 'month'] as const;

const shown = (
  id: string,
  type: CollectionFieldDefinition['type'],
  origin: CollectionFieldDefinition['origin'] = 'source',
): CollectionFieldDefinition => ({ id, type, origin, column: true });

export const customersCatalog: CollectionCatalog = {
  domain: 'customers',
  permission: 'customers.read',
  segments: ['all'],
  defaultSort: { field: 'created', direction: 'desc' },
  defaultColumns: ['name', 'orders', 'spent', 'created', 'state'],
  layouts: ['table', 'list'],
  customFields: 'customer',
  search: 'private',
  fields: [
    { ...shown('name', 'text'), sort: true },
    shown('email', 'text'),
    shown('phone', 'text'),
    {
      ...shown('state', 'enum'),
      options: ['enabled', 'disabled', 'invited', 'declined', 'unknown'],
      filter: ['any_of', 'none_of'],
      group: true,
      quick: true,
    },
    {
      ...shown('source', 'reference'),
      optionSource: 'connections',
      filter: ['any_of', 'none_of'],
      group: true,
      quick: true,
    },
    {
      ...shown('created', 'date'),
      filter: collectionOperators.date,
      sort: true,
      group: dates,
    },
    {
      ...shown('updated', 'date'),
      filter: collectionOperators.date,
      sort: true,
    },
    {
      ...shown('orders', 'number'),
      filter: collectionOperators.number,
      sort: true,
    },
    {
      ...shown('spent', 'money'),
      filter: collectionOperators.money,
      sort: true,
    },
    {
      ...shown('tags', 'tags'),
      filter: collectionOperators.tags,
      group: true,
    },
    {
      id: 'country',
      type: 'text',
      origin: 'source',
      filter: [
        'is',
        'is_not',
        'any_of',
        'none_of',
        'empty',
        'not_empty',
        'unknown',
      ],
      group: true,
    },
    {
      id: 'lastOrder',
      type: 'date',
      origin: 'derived',
      filter: collectionOperators.date,
      sort: true,
      group: dates,
      permission: 'orders.read',
    },
    { id: 'missing', type: 'boolean', origin: 'derived', filter: ['is'] },
    { id: 'contactShared', type: 'boolean', origin: 'source', filter: ['is'] },
  ],
};

export const fulfillmentCatalog: CollectionCatalog = {
  domain: 'fulfillment',
  permission: 'fulfillment.read',
  segments: ['attention', 'held', 'delayed', 'open', 'in_transit', 'all'],
  defaultSort: { field: 'waiting', direction: 'asc' },
  defaultColumns: ['order', 'status', 'signals', 'location', 'progress'],
  layouts: ['table', 'list', 'board'],
  search: 'url',
  fields: [
    shown('order', 'text'),
    // Sort-only fields named like the list API's sorts: last progress, deadline and order number.
    { id: 'waiting', type: 'date', origin: 'derived', sort: true },
    { id: 'deadline', type: 'date', origin: 'derived', sort: true },
    { id: 'orderNumber', type: 'text', origin: 'source', sort: true },
    {
      ...shown('kind', 'enum'),
      options: ['fulfillment_order', 'shipment'],
      filter: choice,
      group: true,
    },
    {
      ...shown('source', 'reference'),
      optionSource: 'connections',
      filter: ['any_of', 'none_of'],
      group: true,
      quick: true,
    },
    {
      ...shown('status', 'enum'),
      options: [
        'pending',
        'processing',
        'completed',
        'shipped',
        'delivered',
        'cancelled',
        'failed',
        'unknown',
      ],
      filter: ['any_of', 'none_of'],
      group: true,
      quick: true,
    },
    {
      ...shown('signals', 'tags', 'derived'),
      options: [
        'held',
        'overdue',
        'stalled',
        'delivery_issue',
        'late_delivery',
        'failed',
      ],
      filter: ['any_of', 'all_of', 'none_of', 'empty', 'not_empty'],
      group: true,
      quick: true,
    },
    {
      ...shown('holds', 'tags'),
      options: [
        'awaiting_payment',
        'high_risk_of_fraud',
        'incorrect_address',
        'inventory_out_of_stock',
        'unknown_delivery_date',
        'awaiting_return_items',
        'other',
      ],
      filter: ['any_of', 'all_of', 'none_of', 'empty', 'not_empty', 'unknown'],
    },
    {
      ...shown('location', 'reference'),
      optionSource: 'locations',
      filter: choice,
      sort: true,
      group: true,
      quick: true,
    },
    {
      ...shown('method', 'text'),
      filter: collectionOperators.text,
      group: true,
    },
    {
      id: 'methodType',
      type: 'enum',
      origin: 'source',
      options: [
        'shipping',
        'pick_up',
        'pickup_point',
        'local',
        'retail',
        'none',
        'unknown',
      ],
      filter: choice,
      group: true,
    },
    {
      ...shown('carrier', 'text'),
      filter: collectionOperators.text,
      group: true,
    },
    {
      ...shown('stage', 'enum', 'derived'),
      options: ['merchant', 'warehouse', 'carrier', 'delivered', 'unknown'],
      filter: choice,
      group: true,
      quick: true,
    },
    {
      ...shown('delivery', 'enum'),
      options: [
        'label_created',
        'in_transit',
        'out_for_delivery',
        'attempted_delivery',
        'delayed',
        'ready_for_pickup',
        'delivered',
        'failed',
      ],
      filter: choice,
      group: true,
    },
    { id: 'hasTracking', type: 'boolean', origin: 'source', filter: ['is'] },
    shown('fulfillAt', 'date'),
    {
      ...shown('fulfillBy', 'date'),
      filter: collectionOperators.date,
      sort: true,
      group: dates,
    },
    {
      ...shown('estimatedDelivery', 'date'),
      filter: collectionOperators.date,
      sort: true,
      group: dates,
    },
    {
      ...shown('progress', 'date', 'derived'),
      filter: collectionOperators.date,
    },
    {
      ...shown('orderPlaced', 'date'),
      filter: collectionOperators.date,
      sort: true,
      group: dates,
    },
    shown('units', 'number'),
    shown('updated', 'date'),
  ],
};

export const productsCatalog: CollectionCatalog = {
  domain: 'products',
  permission: 'products.read',
  segments: ['all', 'differs', 'missing', 'unlinked'],
  defaultSort: null,
  defaultColumns: ['sku', 'listings'],
  layouts: ['table', 'list'],
  customFields: 'product',
  search: 'url',
  fields: [
    { ...shown('sku', 'text'), sort: true },
    { ...shown('title', 'text'), sort: true },
    {
      ...shown('listings', 'reference'),
      optionSource: 'connections',
      filter: ['any_of', 'none_of'],
      sort: true,
      quick: true,
    },
    {
      ...shown('differences', 'tags', 'derived'),
      options: ['title', 'status', 'published', 'price', 'barcode'],
      filter: collectionOperators.tags,
      sort: true,
      group: true,
    },
    {
      ...shown('missing', 'reference', 'derived'),
      optionSource: 'connections',
      filter: choice,
    },
    {
      ...shown('status', 'enum'),
      options: ['active', 'draft', 'archived', 'unknown'],
      filter: ['any_of', 'none_of'],
      group: true,
      quick: true,
      perSource: true,
    },
    {
      id: 'published',
      type: 'boolean',
      origin: 'source',
      filter: ['is'],
      perSource: true,
    },
    {
      ...shown('vendor', 'text'),
      filter: collectionOperators.text,
      group: true,
      perSource: true,
    },
    {
      ...shown('price', 'money'),
      filter: collectionOperators.money,
      sort: true,
      perSource: true,
    },
    {
      id: 'barcode',
      type: 'text',
      origin: 'source',
      filter: collectionOperators.text,
      perSource: true,
    },
    {
      id: 'bundle',
      type: 'boolean',
      origin: 'source',
      filter: ['is'],
      perSource: true,
    },
    {
      ...shown('updated', 'date'),
      filter: collectionOperators.date,
      sort: true,
    },
  ],
};

export const inventoryCatalog: CollectionCatalog = {
  domain: 'inventory',
  permission: 'inventory.read',
  segments: ['all', 'differs', 'unknown'],
  defaultSort: { field: 'sku', direction: 'asc' },
  defaultColumns: [
    'sku',
    'sources',
    'onHand',
    'reserved',
    'available',
    'incoming',
  ],
  layouts: ['table', 'list'],
  search: 'url',
  fields: [
    { ...shown('sku', 'text'), sort: true, group: true },
    {
      ...shown('location', 'reference'),
      optionSource: 'locations',
      filter: ['any_of', 'none_of'],
      sort: true,
      group: true,
      quick: true,
    },
    shown('sources', 'reference'),
    {
      id: 'source',
      type: 'reference',
      origin: 'source',
      optionSource: 'connections',
      filter: ['any_of', 'none_of'],
      group: true,
      quick: true,
    },
    {
      ...shown('onHand', 'number'),
      filter: collectionOperators.number,
      sort: true,
      perSource: true,
    },
    {
      ...shown('reserved', 'number'),
      filter: collectionOperators.number,
      perSource: true,
    },
    {
      ...shown('available', 'number'),
      filter: collectionOperators.number,
      sort: true,
      perSource: true,
    },
    {
      ...shown('incoming', 'number'),
      filter: collectionOperators.number,
      sort: true,
      perSource: true,
    },
    {
      ...shown('differences', 'tags', 'derived'),
      options: ['onHand', 'reserved', 'available'],
      filter: collectionOperators.tags,
    },
    { ...shown('sync', 'boolean', 'derived'), filter: ['is'] },
    {
      id: 'belowSafetyStock',
      type: 'boolean',
      origin: 'derived',
      filter: ['is'],
      perSource: true,
    },
    {
      id: 'availabilityBasis',
      type: 'enum',
      origin: 'source',
      options: ['provider_reported', 'derived', 'unknown'],
      filter: ['any_of', 'none_of'],
      perSource: true,
    },
    {
      id: 'tracked',
      type: 'boolean',
      origin: 'source',
      filter: ['is'],
      perSource: true,
    },
    {
      id: 'itemActive',
      type: 'boolean',
      origin: 'source',
      filter: ['is'],
      perSource: true,
    },
    {
      id: 'locationActive',
      type: 'boolean',
      origin: 'source',
      filter: ['is'],
      perSource: true,
    },
    {
      id: 'lastRead',
      type: 'date',
      origin: 'source',
      filter: collectionOperators.date,
      sort: true,
      perSource: true,
    },
  ],
};

export const transfersCatalog: CollectionCatalog = {
  domain: 'transfers',
  permission: 'inventory.read',
  segments: ['inventory_transfer', 'inventory_shipment'],
  defaultSort: null,
  defaultColumns: [
    'name',
    'route',
    'requested',
    'shipped',
    'received',
    'unreceived',
  ],
  layouts: ['table'],
  search: 'url',
  fields: [
    { ...shown('name', 'text'), sort: true },
    shown('route', 'text'),
    {
      id: 'source',
      type: 'reference',
      origin: 'source',
      optionSource: 'connections',
      filter: ['any_of', 'none_of'],
      quick: true,
    },
    { ...shown('requested', 'number'), filter: collectionOperators.number },
    { ...shown('shipped', 'number'), filter: collectionOperators.number },
    { ...shown('received', 'number'), filter: collectionOperators.number },
    {
      ...shown('unreceived', 'number', 'derived'),
      filter: collectionOperators.number,
    },
    {
      id: 'requestedAt',
      type: 'date',
      origin: 'source',
      filter: collectionOperators.date,
    },
    // Transfer summaries carry no update time, so the list filters and sorts by it only.
    {
      id: 'updated',
      type: 'date',
      origin: 'source',
      filter: collectionOperators.date,
      sort: true,
    },
  ],
};

const amount = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'empty',
  'not_empty',
] as const;

export const returnsCatalog: CollectionCatalog = {
  domain: 'returns',
  permission: 'returns.read',
  segments: ['action', 'waiting', 'done', 'all'],
  defaultSort: null,
  defaultColumns: ['name', 'stage', 'items', 'refund', 'requested', 'activity'],
  layouts: ['table', 'list', 'board'],
  search: 'private',
  fields: [
    shown('name', 'text'),
    {
      id: 'kind',
      type: 'enum',
      origin: 'source',
      options: ['return', 'refund'],
      filter: ['any_of', 'none_of'],
      group: true,
    },
    {
      ...shown('stage', 'enum', 'derived'),
      options: [
        'requested',
        'awaiting_items',
        'awaiting_refund',
        'refund_pending',
        'refund_failed',
        'ready_to_close',
        'refunded',
        'refund_recorded',
        'closed',
        'declined',
        'cancelled',
        'unknown',
      ],
      filter: ['any_of', 'none_of'],
      sort: true,
      group: true,
      quick: true,
    },
    {
      id: 'refundState',
      type: 'enum',
      origin: 'derived',
      options: ['none', 'recorded', 'pending', 'failed', 'partial', 'refunded'],
      filter: ['any_of', 'none_of'],
      group: true,
      quick: true,
    },
    {
      id: 'failedAttempts',
      type: 'number',
      origin: 'derived',
      filter: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between'],
    },
    {
      id: 'reasons',
      type: 'tags',
      origin: 'source',
      filter: ['any_of', 'all_of', 'none_of', 'empty', 'not_empty'],
      group: true,
    },
    { ...shown('items', 'number'), filter: amount },
    { ...shown('refund', 'money'), filter: amount },
    {
      id: 'pendingRefund',
      type: 'money',
      origin: 'source',
      filter: amount,
      sort: true,
    },
    {
      id: 'value',
      type: 'money',
      origin: 'source',
      filter: amount,
      sort: true,
    },
    {
      id: 'partiallyReceived',
      type: 'boolean',
      origin: 'derived',
      filter: ['is', 'unknown'],
    },
    {
      ...shown('requested', 'date'),
      filter: collectionOperators.date,
      sort: true,
      group: dates,
    },
    {
      ...shown('activity', 'date'),
      filter: collectionOperators.date,
      sort: true,
    },
    {
      id: 'source',
      type: 'reference',
      origin: 'source',
      optionSource: 'connections',
      filter: ['any_of', 'none_of'],
      group: true,
      quick: true,
    },
  ],
};

export const procurementCatalog: CollectionCatalog = {
  domain: 'procurement',
  permission: 'procurement.read',
  // Built-in views beside All are the list's `stage` parameter: orders needing an answer,
  // waiting on the supplier and drafts.
  segments: ['all', 'attention', 'awaiting_confirmation', 'draft'],
  defaultSort: { field: 'created', direction: 'desc' },
  defaultColumns: ['reference', 'supplier', 'stage', 'expected', 'nextOwner'],
  layouts: ['table', 'list', 'board'],
  customFields: 'purchase_order',
  search: 'url',
  // Stage, attention, next owner and the progress dates are evaluated in memory at the
  // list's read time; filters and sorts on them read every order before paging.
  fields: [
    {
      ...shown('reference', 'text', 'luma'),
      filter: collectionOperators.text,
      sort: true,
    },
    shown('number', 'text'),
    {
      ...shown('supplier', 'reference', 'luma'),
      optionSource: 'suppliers',
      filter: ['any_of', 'none_of'],
      sort: true,
      group: true,
      quick: true,
    },
    {
      ...shown('status', 'enum', 'luma'),
      options: ['draft', 'open', 'closed', 'cancelled'],
      filter: choice,
      group: true,
      quick: true,
    },
    {
      ...shown('stage', 'enum', 'derived'),
      options: [
        'draft',
        'awaiting_approval',
        'sending',
        'send_failed',
        'awaiting_confirmation',
        'confirmed',
        'changed',
        'partially_received',
        'received',
        'closed',
        'cancelled',
      ],
      filter: ['any_of', 'none_of'],
      group: true,
      quick: true,
    },
    {
      ...shown('attention', 'tags', 'derived'),
      options: [
        'submission_uncertain',
        'submission_failed',
        'review_commitment',
        'commitment_changed',
        'confirmation_overdue',
        'delivery_overdue',
        'receipt_difference',
      ],
      filter: collectionOperators.tags,
    },
    {
      ...shown('expected', 'date'),
      filter: collectionOperators.date,
      sort: true,
    },
    {
      ...shown('confirmationDue', 'date', 'derived'),
      filter: collectionOperators.date,
      sort: true,
    },
    {
      ...shown('nextCheck', 'date', 'derived'),
      filter: collectionOperators.date,
      sort: true,
    },
    {
      ...shown('nextOwner', 'enum', 'derived'),
      options: ['buyer', 'approver', 'supplier', 'warehouse', 'luma', 'none'],
      filter: choice,
      group: true,
    },
    {
      ...shown('lines', 'number', 'luma'),
      filter: collectionOperators.number,
    },
    {
      ...shown('created', 'date', 'luma'),
      filter: collectionOperators.date,
      sort: true,
    },
    {
      ...shown('updated', 'date', 'luma'),
      filter: collectionOperators.date,
      sort: true,
    },
    {
      ...shown('authority', 'enum', 'luma'),
      options: ['luma', 'external'],
      filter: choice,
      group: true,
    },
    {
      ...shown('location', 'reference', 'luma'),
      optionSource: 'locations',
      filter: choice,
    },
    {
      ...shown('sku', 'text', 'luma'),
      filter: ['contains', 'not_contains', 'is', 'is_not'],
    },
    {
      ...shown('value', 'money', 'derived'),
      filter: [...collectionOperators.money, 'unknown'],
      sort: true,
    },
  ],
};

export const suppliersCatalog: CollectionCatalog = {
  domain: 'suppliers',
  permission: 'procurement.read',
  segments: ['all'],
  defaultSort: { field: 'name', direction: 'asc' },
  defaultColumns: ['name', 'link', 'references', 'created', 'orders'],
  layouts: ['table'],
  customFields: 'supplier',
  search: 'url',
  fields: [
    { ...shown('name', 'text', 'luma'), sort: true },
    shown('link', 'text', 'luma'),
    shown('references', 'text', 'luma'),
    {
      ...shown('created', 'date', 'luma'),
      filter: collectionOperators.date,
      sort: true,
    },
    { ...shown('orders', 'number', 'derived'), sort: true },
    {
      id: 'hasOpenOrders',
      type: 'boolean',
      origin: 'derived',
      filter: ['is'],
    },
    {
      id: 'confirmationOverdue',
      type: 'boolean',
      origin: 'derived',
      filter: ['is'],
    },
  ],
};

// Issues, Needs you and the inbox show work rather than records. Their filters stay on
// structured properties: free text never matches message bodies, and search text never enters
// a view.
const someOf = ['any_of', 'none_of'] as const;
const period = ['before', 'after', 'between', 'within_last'] as const;
const deadline = [
  'before',
  'after',
  'between',
  'within_last',
  'within_next',
  'empty',
  'not_empty',
] as const;
const person = ['any_of', 'none_of', 'empty', 'not_empty'] as const;

export const issuesCatalog: CollectionCatalog = {
  domain: 'issues',
  permission: 'issues.read',
  segments: ['active', 'needs_you', 'history'],
  defaultSort: { field: 'urgency', direction: 'asc' },
  defaultColumns: ['summary', 'class', 'severity', 'state', 'owner'],
  layouts: ['list', 'board'],
  search: 'private',
  fields: [
    shown('summary', 'text', 'derived'),
    // Sort-only: severity, then the oldest attention request or detection.
    { id: 'urgency', type: 'number', origin: 'derived', sort: true },
    {
      ...shown('class', 'enum', 'derived'),
      options: caseClasses,
      filter: someOf,
      group: true,
      quick: true,
    },
    {
      ...shown('state', 'enum', 'luma'),
      options: caseStates,
      filter: someOf,
      group: true,
      quick: true,
    },
    {
      ...shown('severity', 'enum', 'derived'),
      options: ['high', 'medium'],
      filter: someOf,
      group: true,
      quick: true,
    },
    shown('subject', 'text'),
    {
      id: 'subjectType',
      type: 'enum',
      origin: 'source',
      options: caseSubjectKinds,
      filter: someOf,
    },
    {
      ...shown('owner', 'person', 'luma'),
      optionSource: 'members',
      filter: person,
      group: true,
    },
    // Provider systems named by the current investigation's evidence.
    {
      ...shown('source', 'tags'),
      optionSource: 'systems',
      filter: ['any_of', 'none_of', 'empty', 'not_empty'],
      group: true,
    },
    {
      ...shown('attention', 'enum', 'derived'),
      options: ['approval', 'manual_intervention', 'uncertainty'],
      filter: choice,
    },
    {
      ...shown('freshness', 'enum', 'derived'),
      options: ['fresh', 'stale', 'unknown'],
      filter: someOf,
    },
    {
      ...shown('diagnosis', 'enum', 'derived'),
      options: ['pending', 'ready', 'insufficient_evidence', 'failed'],
      filter: someOf,
    },
    {
      ...shown('resolution', 'enum', 'luma'),
      options: ['verified', 'human_disposition'],
      filter: choice,
    },
    {
      ...shown('detected', 'date', 'luma'),
      filter: period,
      sort: true,
    },
    {
      ...shown('lastActivity', 'date', 'luma'),
      filter: period,
      sort: true,
    },
    {
      ...shown('waitingSince', 'date', 'derived'),
      filter: deadline,
      sort: true,
    },
  ],
};

export const decisionsCatalog: CollectionCatalog = {
  domain: 'decisions',
  permission: 'issues.read',
  segments: ['all', 'mine', 'unassigned'],
  defaultSort: { field: 'urgency', direction: 'asc' },
  defaultColumns: ['title', 'kind', 'owner', 'deadline'],
  layouts: ['list'],
  search: 'private',
  fields: [
    shown('title', 'text', 'derived'),
    // Sort-only: proposals about to expire, then high impact, then the earliest deadline.
    { id: 'urgency', type: 'number', origin: 'derived', sort: true },
    { ...shown('kind', 'enum', 'derived'), options: decisionKinds },
    {
      ...shown('domain', 'enum', 'derived'),
      options: decisionDomains,
      filter: someOf,
      group: true,
      quick: true,
    },
    {
      ...shown('reason', 'enum', 'derived'),
      options: decisionReasons,
      filter: someOf,
      group: true,
      quick: true,
    },
    {
      ...shown('owner', 'person', 'luma'),
      optionSource: 'members',
      filter: person,
      group: true,
    },
    // Decisions with the same cause; each still needs its own response.
    { id: 'cause', type: 'text', origin: 'derived', group: true },
    {
      ...shown('requested', 'date', 'luma'),
      filter: period,
      sort: true,
    },
    {
      ...shown('deadline', 'date', 'derived'),
      filter: deadline,
      sort: true,
    },
    {
      ...shown('impact', 'enum', 'derived'),
      options: decisionImpacts,
      filter: someOf,
    },
  ],
};

export const inboxCatalog: CollectionCatalog = {
  domain: 'inbox',
  permission: 'messages.read',
  segments: [
    'open',
    'mine',
    'unassigned',
    'overdue',
    'review',
    'closed',
    'all',
  ],
  defaultSort: { field: 'activity', direction: 'desc' },
  defaultColumns: ['correspondent', 'subject', 'owner', 'status', 'activity'],
  layouts: ['list'],
  search: 'private',
  fields: [
    shown('correspondent', 'text'),
    shown('subject', 'text'),
    {
      ...shown('owner', 'person', 'luma'),
      optionSource: 'members',
      filter: person,
      group: true,
    },
    {
      ...shown('status', 'enum', 'luma'),
      options: threadStatuses,
      filter: someOf,
      group: true,
    },
    {
      ...shown('mailbox', 'reference'),
      optionSource: 'mailboxes',
      filter: someOf,
      group: true,
      quick: true,
    },
    { ...shown('due', 'date', 'luma'), filter: deadline, sort: true },
    { ...shown('activity', 'date'), filter: period, sort: true },
    // Kinds of the records a thread is linked to, never the records' content.
    {
      id: 'linkedRecord',
      type: 'tags',
      origin: 'luma',
      options: linkedRecordKinds,
      filter: ['any_of', 'none_of', 'empty', 'not_empty'],
    },
    { id: 'hasAttachments', type: 'boolean', origin: 'source', filter: ['is'] },
    { id: 'awaitingReply', type: 'boolean', origin: 'derived', filter: ['is'] },
    {
      id: 'factsToReview',
      type: 'boolean',
      origin: 'derived',
      filter: ['is'],
    },
  ],
};

// Activity filters map to the activity API's parameters, so each field takes one value except
// the actor, and the recorded time takes a relative period or a calendar range.
export const activityCatalog: CollectionCatalog = {
  domain: 'activity',
  permission: 'activity.read',
  segments: ['all'],
  defaultSort: null,
  defaultColumns: ['time', 'action', 'actor', 'outcome'],
  layouts: ['list'],
  search: 'url',
  fields: [
    { ...shown('time', 'date', 'luma'), filter: ['within_last', 'between'] },
    shown('action', 'text', 'luma'),
    {
      ...shown('actor', 'person', 'luma'),
      optionSource: 'members',
      filter: ['any_of'],
    },
    {
      ...shown('outcome', 'enum', 'luma'),
      options: activityOutcomes,
      filter: ['any_of'],
    },
    {
      id: 'type',
      type: 'enum',
      origin: 'luma',
      options: activityTypes,
      filter: ['any_of'],
    },
    { id: 'system', type: 'enum', origin: 'source', filter: ['any_of'] },
    {
      id: 'connection',
      type: 'reference',
      origin: 'source',
      optionSource: 'connections',
      filter: ['any_of'],
    },
  ],
};

// The workflow library filters and groups its few dozen workflows in the browser; it keeps only
// personal display settings, such as collapsed lifecycle groups, as list state.
export const workflowsCatalog: CollectionCatalog = {
  domain: 'workflows',
  permission: 'workflows.read',
  segments: ['all'],
  defaultSort: null,
  defaultColumns: ['name'],
  layouts: ['list'],
  search: 'url',
  fields: [shown('name', 'text', 'luma')],
};

/** Every list's catalog. A list's fields gain filters, sorts and groups as its API adds them. */
export const collectionCatalogs: Record<CollectionDomain, CollectionCatalog> = {
  orders: ordersCatalog,
  customers: customersCatalog,
  fulfillment: fulfillmentCatalog,
  products: productsCatalog,
  inventory: inventoryCatalog,
  transfers: transfersCatalog,
  returns: returnsCatalog,
  procurement: procurementCatalog,
  suppliers: suppliersCatalog,
  issues: issuesCatalog,
  decisions: decisionsCatalog,
  inbox: inboxCatalog,
  activity: activityCatalog,
  workflows: workflowsCatalog,
};
