import type { OperationalPackage } from './packages.js';

const actionId = 'fd645336-6d1e-50e5-a55d-f850e3acdd0d';

/** One maintained purchasing definition; configuration is resolved by the reviewed install. */
export const purchasingPackage: OperationalPackage = {
  id: 'supplier-confirmations',
  version: '1.0.0',
  name: { en: 'Supplier confirmations', de: 'Lieferantenbestätigungen' },
  description: {
    en: 'Keep overdue supplier confirmations together and prepare governed follow-ups.',
    de: 'Bündele überfällige Lieferantenbestätigungen und bereite kontrollierte Nachfragen vor.',
  },
  permissions: [
    'adaptive.fields.manage',
    'adaptive.fields.read',
    'adaptive.fields.write',
    'procurement.read',
    'procurement.manage',
    'messages.read',
    'messages.send',
    'workflows.read',
    'workflows.publish',
  ],
  requirements: ['supplier.follow-up'],
  parameters: [
    {
      key: 'mailboxId',
      type: 'string',
      required: true,
      label: {
        en: 'Operations Inbox connection',
        de: 'Verbindung des operativen Posteingangs',
      },
      default: null,
    },
    {
      key: 'nextCheckHours',
      type: 'number',
      required: true,
      label: {
        en: 'Hours until the next follow-up check',
        de: 'Stunden bis zur nächsten Nachfrageprüfung',
      },
      default: 48,
    },
    {
      key: 'fieldLabelEn',
      type: 'string',
      required: true,
      label: {
        en: 'Buyer field label in English',
        de: 'Englische Bezeichnung des Einkaufsfelds',
      },
      default: 'Buyer note',
    },
    {
      key: 'fieldLabelDe',
      type: 'string',
      required: true,
      label: {
        en: 'Buyer field label in German',
        de: 'Deutsche Bezeichnung des Einkaufsfelds',
      },
      default: 'Einkaufsnotiz',
    },
    {
      key: 'fieldReadPermission',
      type: 'string',
      required: true,
      label: {
        en: 'Buyer field read permission',
        de: 'Leseberechtigung des Einkaufsfelds',
      },
      default: 'adaptive.fields.read',
    },
    {
      key: 'fieldWritePermission',
      type: 'string',
      required: true,
      label: {
        en: 'Buyer field edit permission',
        de: 'Bearbeitungsberechtigung des Einkaufsfelds',
      },
      default: 'adaptive.fields.write',
    },
  ],
  fields: [
    {
      key: 'buyer-note',
      definition: {
        recordType: 'purchase_order',
        key: 'supplier_confirmations_buyer_note',
        label: { en: 'Buyer note', de: 'Einkaufsnotiz' },
        type: 'text',
        choices: [],
        readPermission: 'adaptive.fields.read',
        writePermission: 'adaptive.fields.write',
      },
    },
  ],
  views: [
    {
      key: 'overdue-confirmations',
      definition: {
        name: 'Overdue supplier confirmations',
        description: 'Supplier confirmations needing a follow-up.',
        sharing: { scope: 'workspace', roleIds: [] },
        reviewed: true,
        query: {
          version: 1,
          domain: 'procurement',
          filters: { attention: 'confirmation_overdue' },
          customFilters: [],
          columns: [
            'reference',
            'supplierName',
            'confirmationDueAt',
            'attentionKey',
          ],
          sort: null,
          groupBy: 'supplierName',
          layout: 'table',
          metrics: [{ id: 'overdue', operation: 'count', field: null }],
          charts: [],
          actions: [
            {
              id: actionId,
              label: { en: 'Prepare follow-up', de: 'Nachfrage vorbereiten' },
              target: { kind: 'capability', id: 'supplier.follow-up' },
              inputs: {
                connectionId: { source: 'literal', value: '' },
                attentionKey: { source: 'row', field: 'attentionKey' },
                nextCheckHours: { source: 'literal', value: 48 },
                reason: {
                  source: 'literal',
                  value: 'Request an updated supplier confirmation.',
                },
              },
            },
          ],
        },
      },
    },
  ],
  workflows: [
    {
      key: 'confirmation-review',
      definition: {
        schemaVersion: 2,
        definition: {
          id: 'supplier-confirmations-review',
          name: 'Review supplier confirmation',
          intent:
            'Review supplier evidence before preparing a controlled follow-up.',
          category: 'procurement',
        },
        version: '1.0.0',
        applicability: {
          trigger: { kind: 'manual' },
          subjectKind: 'purchase_order',
        },
        inputs: { purchaseOrderId: 'string' },
        context: {
          kind: 'supplier_confirmation',
          fields: { attentionKey: 'string' },
          maxAgeSeconds: 300,
        },
        steps: [
          {
            id: 'review',
            kind: 'human_task',
            assignee: { kind: 'role', key: 'admin' },
            instructions:
              'Review the supplier confirmation and its evidence. Prepare a follow-up through the purchase order or Operations Inbox when needed.',
            choices: ['Follow up', 'Confirmation found'],
            evidence: 'record',
            dueAfterSeconds: 172800,
            escalationTarget: { kind: 'role', key: 'owner' },
          },
          { id: 'done', kind: 'end', outcome: 'Supplier evidence reviewed' },
        ],
      },
    },
  ],
};

/** A later version adds a useful view without changing workspace choices or local resources. */
export const purchasingPackageNext: OperationalPackage = {
  ...purchasingPackage,
  version: '1.1.0',
  views: [
    ...purchasingPackage.views,
    {
      key: 'overdue-deliveries',
      definition: {
        name: 'Overdue supplier deliveries',
        description: 'Promised deliveries needing a fresh check.',
        sharing: { scope: 'workspace', roleIds: [] },
        reviewed: true,
        query: {
          version: 1,
          domain: 'procurement',
          filters: { attention: 'delivery_overdue' },
          customFilters: [],
          columns: [
            'reference',
            'supplierName',
            'confirmationDueAt',
            'attentionKey',
          ],
          sort: null,
          groupBy: 'supplierName',
          layout: 'table',
          metrics: [],
          charts: [],
          actions: [],
        },
      },
    },
  ],
};
