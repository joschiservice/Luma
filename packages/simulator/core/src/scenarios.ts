import type { FaultKind } from './faults.js';
import type { IncidentKindName } from './incidents.js';

/** One provider change a scenario makes. `shop` is the run's first shop. */
type ScenarioStep =
  | { kind: 'incident'; incident: IncidentKindName; on: 'shop' }
  | {
      kind: 'fault';
      on: 'shop';
      operation: string;
      fault: FaultKind;
      remaining: number;
      /** Simulation time after which an unused rule no longer applies. */
      lifetimeMs: number;
    };

/** A reproducible situation for Luma's case workflows, with what Luma should do. */
export interface WorkflowScenario {
  label: string;
  description: string;
  /** What Luma should show and do, in order, so people can check the outcome. */
  expected: string;
  steps: ScenarioStep[];
}

const drift: ScenarioStep = {
  kind: 'incident',
  incident: 'inventory-drift',
  on: 'shop',
};

/**
 * Situations that exercise a configured workflow end to end, including its failure paths. Each
 * uses the incident and fault-rule mechanisms, so the scorecard and journal show it as usual.
 */
export const workflowScenarios = {
  'stock-correction': {
    label: 'Stock correction',
    description:
      'Shopify stock stops following JTL for the most-demanded SKU of the first shop.',
    expected:
      'A stock case opens, and Correct Shopify stock from the ERP proposes the JTL quantity. Approve it in Needs you; it stays open for four hours. Luma rereads stock, writes it, confirms it with a fresh Shopify read, and detection then closes the case.',
    steps: [drift],
  },
  'stock-correction-moves': {
    label: 'Stock moves while waiting',
    description:
      'The same drift, but let the shop sell before approving the proposal.',
    expected:
      'When Shopify’s quantity changes, the waiting proposal no longer runs. Luma prepares one new proposal from current stock, in the same Needs you item, and nothing is written until someone approves it.',
    steps: [drift],
  },
  'stock-correction-lost-response': {
    label: 'Write commits, response lost',
    description:
      'Shopify applies Luma’s stock correction but the response never arrives.',
    expected:
      'After approval the write is uncertain. Luma reconciles by reading Shopify, never by writing again, then verifies the quantity. The scorecard shows no repeated writes.',
    steps: [
      {
        kind: 'fault',
        on: 'shop',
        operation: 'inventory.available.reconcile',
        fault: 'response-loss',
        remaining: 1,
        // An abandoned scenario must not surprise a later correction.
        lifetimeMs: 2 * 60 * 60_000,
      },
      drift,
    ],
  },
  'hold-release': {
    label: 'Overdue fraud hold',
    description: 'A new order is held for fraud review and nobody releases it.',
    expected:
      'Once the hold is overdue, a stuck-fulfillment case opens and Release an overdue fulfillment hold proposes releasing it. After approval Shopify shows no hold. The case stays open until the warehouse ships the order.',
    steps: [{ kind: 'incident', incident: 'fraud-hold', on: 'shop' }],
  },
  'connection-outage': {
    label: 'Shop outage',
    description: 'The first shop is unavailable for 30 minutes.',
    expected:
      'Reads fail, and after the retry window a sync-failure case opens. Check a failing connection waits 15 minutes and checks again: it ends when reads recovered, or hands the case to a person.',
    steps: [{ kind: 'incident', incident: 'provider-outage', on: 'shop' }],
  },
  'supplier-silent': {
    label: 'Supplier stays silent',
    description:
      'ERP suppliers stop confirming purchase orders placed from now on.',
    expected:
      'Once a sent order passes its confirmation time, Follow up on an overdue supplier order notes a follow-up, so Needs you stays quiet while it waits. If the supplier is still silent afterwards, the order returns to Needs you for a buyer.',
    steps: [{ kind: 'incident', incident: 'supplier-silent', on: 'shop' }],
  },
  'refund-missing': {
    label: 'Refund never issued',
    description:
      'A shipped order is returned now; the items arrive, but no refund follows.',
    expected:
      'After the refund window, Chase a refund after a return arrives hands the return to a person in Needs you. Luma never refunds by itself; the item leaves Needs you once a refund is recorded.',
    steps: [{ kind: 'incident', incident: 'refund-missing', on: 'shop' }],
  },
  'payment-stuck': {
    label: 'Payment stuck pending',
    description: 'A new order’s payment stays pending and never settles.',
    expected:
      'After the payment window, Follow up on a payment that stays pending hands the order to a person in Needs you. Luma never holds or cancels it; the item leaves once the payment settles.',
    steps: [{ kind: 'incident', incident: 'payment-stuck', on: 'shop' }],
  },
  'access-revoked': {
    label: 'Access revoked',
    description: 'The first shop rejects Luma’s credentials for an hour.',
    expected:
      'Luma revokes the connection and a sync-failure case opens for lost access. Check a failing connection hands it to a person at once with Reconnect. The case closes only after the store is reconnected and completes a fresh scan.',
    steps: [{ kind: 'incident', incident: 'auth-revoked', on: 'shop' }],
  },
} satisfies Record<string, WorkflowScenario>;

export type WorkflowScenarioName = keyof typeof workflowScenarios;

export const workflowScenarioNames = Object.keys(
  workflowScenarios,
) as WorkflowScenarioName[];
