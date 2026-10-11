import { randomUUID } from 'node:crypto';

import { guid } from '@luma/simulator-cin7';
import type { MerchantProfile } from '@luma/simulator-commerce';
import {
  type ChaosProfile,
  type IncidentKindName,
  incidentKinds,
  type ProviderContext,
  type ProviderEvent,
  type RecordStore,
} from '@luma/simulator-core';
import {
  gmail,
  type GmailCommand,
  type GmailCommandResult,
} from '@luma/simulator-gmail';
import {
  jtl,
  type JtlCommand,
  type JtlCommandResult,
} from '@luma/simulator-jtl';
import {
  shopify,
  type ShopifyCommand,
  type ShopifyCommandResult,
} from '@luma/simulator-shopify';

import { cin7 } from './cin7.js';
import type {
  ErpInstance,
  Instance,
  MailboxInstance,
  WorldModel,
} from './model.js';

export type HealthStatus =
  'healthy' | 'rate-limited' | 'unavailable' | 'unauthorized';

/** A service health override; timed overrides come from provider-level incidents. */
export interface HealthWindow {
  status: HealthStatus;
  /** Simulation time when the override ends. */
  until?: number | undefined;
  incident?: string | undefined;
}

/** Engine counters and carry-over values that are not provider records. */
export interface EngineState {
  /** Unused fractional pick capacity per warehouse. */
  pickCarry: Record<string, number>;
  /** Simulation time of the next stock push. */
  nextStockSync: number;
}

export interface RunState {
  id: string;
  seed: number;
  profile: MerchantProfile;
  chaos: ChaosProfile;
  /** Simulation time when the run's live period started, after history. */
  startedAt: number;
  state: EngineState;
  health: Record<string, HealthWindow>;
}

/** Everything one engine step reads and changes. Sinks buffer until the caller commits. */
export interface World {
  run: RunState;
  model: WorldModel;
  /** Simulation time of the current step. */
  now: number;
  wallTime: number;
  /** False while creating history: no chaos incidents, journal entries or webhooks. */
  live: boolean;
  store(instance: string): RecordStore;
  journal(
    kind: string,
    detail: unknown,
    instance?: string,
    resource?: string,
  ): void;
  metric(
    name: string,
    value: number,
    instance?: string,
    mode?: 'add' | 'max',
  ): void;
  /** Queues a webhook for a provider change. */
  webhook(instance: string, event: ProviderEvent): void;
}

export interface Incident {
  id: string;
  kind: IncidentKindName;
  origin: 'injected' | 'emerged';
  status: 'planned' | 'active' | 'recovered';
  startedAt: number;
  endedAt: number | null;
  instance: string | null;
  summary: string;
  resources: { instance: string; kind: string; id: string; label: string }[];
  detail: Record<string, unknown>;
}

export const worldInstance = 'world';

/** Returns the provider instance with this name or throws. */
export function instance(world: World, name: string): Instance {
  const found = world.model.instances.find((item) => item.name === name);
  if (!found) throw new Error(`Unknown instance ${name}`);

  return found;
}

/** Builds a provider context whose notifications are handled after the call. */
export function providerContext(
  world: World,
  name: string,
  events: ProviderEvent[],
): ProviderContext<Instance['config']> {
  return {
    store: world.store(name),
    now: world.now,
    wallTime: world.wallTime,
    instance: name,
    config: instance(world, name).config,
    indexLagMs: world.run.chaos.transport.indexLagMs,
    notify: (event) => events.push(event),
  };
}

/** A Shopify context; notifications go to `events` when given. */
export function shopContext(
  world: World,
  name: string,
  events: ProviderEvent[] = [],
) {
  return providerContext(world, name, events) as ProviderContext<
    Extract<Instance, { kind: 'shopify' }>['config']
  >;
}

/** An ERP context; notifications go to `events` when given. */
export function erpContext(world: World, events: ProviderEvent[] = []) {
  return providerContext(
    world,
    world.model.erp.name,
    events,
  ) as ProviderContext<ErpInstance['config']>;
}

/** The operations mailbox's context; Gmail notifications are not delivered anywhere. */
export function mailContext(world: World, events: ProviderEvent[] = []) {
  return providerContext(
    world,
    world.model.mailbox.name,
    events,
  ) as ProviderContext<MailboxInstance['config']>;
}

/**
 * An ERP sales order or item as an incident resource, identified as Luma reads it through the
 * ERP's API, so the scorecard can find it in case evidence.
 */
export function erpResource(
  world: World,
  kind: 'salesOrder' | 'item',
  id: string,
  label?: string,
) {
  const erp = world.model.erp;
  const cin7Record = erp.kind === 'cin7';

  return {
    instance: erp.name,
    kind,
    id: cin7Record ? guid(kind === 'salesOrder' ? 'sale' : 'product', id) : id,
    label: label ?? `${cin7Record ? 'Cin7 sale' : 'JTL order'} ${id}`,
  };
}

/** Engine events and their payloads; every scheduled transition is one of these. */
export interface EngineEvents {
  'import-order': { shop: string; order: string };
  payment: { shop: string; order: string; paid: boolean };
  'customer-cancel': { shop: string; order: string };
  'release-hold': { shop: string; order: string };
  'shipment-sync': {
    shop: string;
    order: string;
    lines: { variant: string; quantity: number }[];
    carrier: string;
    trackingNumber: string;
    trackingUrl: string;
    transitMs: number;
    /** Earlier failed attempts; the integration retries a few times. */
    attempt?: number | undefined;
  };
  carrier: {
    shop: string;
    order: string;
    fulfillment: string;
    status: 'DELIVERED' | 'DELAYED' | 'FAILURE';
  };
  return: {
    shop: string;
    order: string;
    step: 'request' | 'decide' | 'receive' | 'refund' | 'settle' | 'close';
    lines?: { lineItem: string; quantity: number }[] | undefined;
  };
  supplier: { command: Record<string, unknown> };
  /** The ERP emails a new purchase order to its supplier from the operations mailbox. */
  'purchase-order-mail': { purchaseOrder: string };
}

/** A stored engine event. */
export type EngineEvent = {
  [K in keyof EngineEvents]: { kind: K; payload: EngineEvents[K] };
}[keyof EngineEvents];

/** Schedules an engine event at simulation time `at`. */
export async function schedule<K extends keyof EngineEvents>(
  world: World,
  at: number,
  kind: K,
  payload: EngineEvents[K],
) {
  const store = world.store(worldInstance);
  const id = String(await store.sequence('event'));
  await store.put(
    'event',
    id,
    { kind, payload },
    { updatedAt: Math.round(at) },
  );
}

/**
 * Handles provider notifications: Shopify changes become webhooks and recorded purchase
 * orders schedule their supplier's answers.
 */
export async function handleEvents(
  world: World,
  name: string,
  events: ProviderEvent[],
) {
  for (const event of events) {
    const kind = instance(world, name).kind;
    if (kind === 'shopify') {
      world.webhook(name, event);
      continue;
    }
    // Gmail push goes through Google Pub/Sub, which is not simulated; Luma polls the mailbox.
    if (kind === 'gmail') continue;
    // The ERP sends no webhooks; stock changes feed the merchant's stock connector.
    if (
      event.topic === 'items/stock' &&
      world.model.profile.integration.stockSyncEveryMs
    )
      await world
        .store(worldInstance)
        .put('dirty', event.resource, {}, { updatedAt: world.now });
    if (event.topic === 'purchase-orders/create')
      await schedule(world, world.now + 5_000, 'purchase-order-mail', {
        purchaseOrder: event.resource,
      });
    const supplierEvents = event.payload.supplierEvents;
    if (
      event.topic === 'purchase-orders/create' &&
      Array.isArray(supplierEvents)
    )
      for (const answer of supplierEvents as {
        delay: number;
        command: Record<string, unknown>;
      }[])
        await schedule(world, world.now + answer.delay, 'supplier', {
          command: answer.command,
        });
  }
}

/** Runs a merchant or integration command against Shopify. */
export async function shop(
  world: World,
  name: string,
  command: ShopifyCommand,
): Promise<ShopifyCommandResult> {
  const events: ProviderEvent[] = [];
  const result = await shopify.command(
    shopContext(world, name, events),
    command,
  );
  await handleEvents(world, name, events);

  return result;
}

/** Runs a merchant, warehouse or supplier command against the ERP. */
export async function erp(
  world: World,
  command: JtlCommand,
): Promise<JtlCommandResult> {
  const events: ProviderEvent[] = [];
  const context = erpContext(world, events);
  // The simulated Cin7 account runs the same ERP model behind Cin7's API.
  const result =
    world.model.erp.kind === 'cin7'
      ? await cin7.command(
          context as ProviderContext<
            Extract<ErpInstance, { kind: 'cin7' }>['config']
          >,
          command,
        )
      : await jtl.command(context, command);
  await handleEvents(world, world.model.erp.name, events);
  if (result.supplierEvents)
    for (const answer of result.supplierEvents)
      await schedule(world, world.now + answer.delay, 'supplier', {
        command: answer.command,
      });

  return result;
}

/** Applies a command to the operations mailbox, such as delivering a supplier's email. */
export async function mail(
  world: World,
  command: GmailCommand,
): Promise<GmailCommandResult> {
  return gmail.command(mailContext(world), command);
}

/** Records a ground-truth incident; Luma never reads it. */
export async function openIncident(
  world: World,
  input: Omit<Incident, 'id' | 'status' | 'startedAt' | 'endedAt'> & {
    id?: string | undefined;
    status?: 'planned' | 'active' | undefined;
  },
) {
  const incident: Incident = {
    ...input,
    id: input.id ?? randomUUID(),
    status: input.status ?? 'active',
    startedAt: world.now,
    endedAt: null,
  };
  await world.store(worldInstance).put('incident', incident.id, incident, {
    key: incident.status,
    updatedAt: world.now,
  });
  world.journal(
    'incident',
    {
      id: incident.id,
      kind: incident.kind,
      origin: incident.origin,
      summary: incident.summary,
    },
    incident.instance ?? undefined,
    incident.resources[0]?.id,
  );
  world.metric('incidents.opened', 1, incident.instance ?? undefined);

  return incident;
}

/** Marks an incident recovered; repeated recovery is a no-op. */
export async function closeIncident(world: World, id: string, reason: string) {
  const store = world.store(worldInstance);
  const record = await store.get<Incident>('incident', id);
  if (!record || record.data.status === 'recovered') return record?.data;
  const incident = {
    ...record.data,
    status: 'recovered' as const,
    endedAt: world.now,
  };
  await store.put('incident', id, incident, { key: 'recovered' });
  world.journal(
    'incident-recovered',
    { id, kind: incident.kind, reason },
    incident.instance ?? undefined,
  );

  return incident;
}

/** Labels an incident kind for summaries. */
export const incidentLabel = (kind: IncidentKindName) =>
  incidentKinds[kind].label;
