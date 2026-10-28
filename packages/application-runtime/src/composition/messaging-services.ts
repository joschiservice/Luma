import { createHash } from 'node:crypto';

import { createAuditLog } from '@luma/audit/composition';
import type { EffectRegistry } from '@luma/connections';
import type { IdentityService } from '@luma/identity';
import { createMessaging } from '@luma/messaging/composition';
import type { TenantDatabase } from '@luma/platform';
import {
  createSupplierEmailService,
  type SupplierCommitments,
} from '@luma/procurement/composition';

import type { ApplicationOptions, EffectFamily } from './application.js';
import type { createTenantFeatureRelease } from './feature-release.js';
import {
  createMailboxConnections,
  createMemberDirectory,
  createMessageReader,
  createProcurementHandoff,
  createRecordDirectory,
} from './messaging.js';
import {
  createAttachmentReader,
  createDocumentDirectory,
} from './messaging-documents.js';
import {
  createRecordStates,
  createReplyAdmission,
} from './messaging-replies.js';
import type { createSafetyServices } from './services.js';

/**
 * Composes mailboxes, threads and replies together with supplier email, which read each other once
 * requests arrive. Without a mailbox reader, messages and attachments are not read; replies are
 * admitted through `safety` and `effects` only when the `reply` family is resolvable. `orders` is
 * read only once drafts need an order. Supplier email answers only for tenants with its release.
 */
export function createMessagingServices(options: {
  database: TenantDatabase;
  identity: IdentityService;
  messaging: ApplicationOptions['messaging'];
  modelGateway: ApplicationOptions['modelGateway'];
  documentExtraction: ApplicationOptions['documentExtraction'];
  commitments: SupplierCommitments;
  orders: Parameters<typeof createRecordStates>[0]['orders'];
  resolvable: ReadonlySet<EffectFamily>;
  safety: ReturnType<typeof createSafetyServices>;
  effects: EffectRegistry;
  release: ReturnType<typeof createTenantFeatureRelease>;
}): {
  messaging: ReturnType<typeof createMessaging>;
  supplierEmail: ReturnType<typeof createSupplierEmailService>;
} {
  const { database, identity, commitments, resolvable, safety, release } =
    options;
  const directory = createRecordDirectory(database);
  const messaging = createMessaging(database, {
    audit: createAuditLog,
    refreshContext: identity.refreshContext,
    resolveContext: identity.resolveWorkflowContext,
    connections: createMailboxConnections(
      database,
      options.messaging?.installations ?? { list: async () => [] },
    ),
    directory,
    members: createMemberDirectory(identity),
    reader: options.messaging?.reader
      ? createMessageReader(options.messaging.reader)
      : undefined,
    handoff: createProcurementHandoff(() => commitments),
    settled: (context, outbound) => supplierEmail.settled(context, outbound),
    eligibleOwner: (context, outbound) =>
      supplierEmail.eligible(context, outbound),
    records: createRecordStates({
      orders: options.orders,
      commitments: () => commitments,
      directory,
    }),
    replyAdmission: resolvable.has('reply')
      ? createReplyAdmission(safety, options.effects)
      : null,
    // Attachments are read through the same installed runtime as messages.
    documents: {
      attachments: options.messaging?.reader
        ? createAttachmentReader(options.messaging.reader)
        : undefined,
      directory: createDocumentDirectory(database),
      extraction: {
        gateway: options.modelGateway ?? null,
        available: options.documentExtraction?.available ?? false,
        reason: options.documentExtraction?.reason ?? null,
      },
    },
    retentionDays: options.messaging?.retentionDays,
    pollMs: options.messaging?.pollMs,
    log: options.messaging?.log,
  });
  const supplierEmail = createSupplierEmailService({
    commitments,
    refreshContext: identity.refreshContext,
    available: (context, feature) =>
      release(
        context.tenantId,
        feature === 'submission'
          ? 'procurement-email-submission'
          : 'procurement-supplier-follow-ups',
      ),
    digest: (value) =>
      createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    now: () => new Date(),
    inbox: {
      mailboxes: (context) => messaging.service.mailboxes(context),
      work: (context, id) => messaging.replies.supplierWork(context, id),
      attachment: (context, orderId, outboundId) =>
        messaging.replies.supplierAttachment(context, orderId, outboundId),
      compose: (context, input) => messaging.replies.compose(context, input),
      threads: async (context, id) =>
        (
          await messaging.service.recordThreads(context, 'purchase_order', id)
        ).items.map((t) => ({
          id: t.id,
          connectionId: t.connectionId,
          address: t.correspondent?.address ?? null,
        })),
    },
  });

  return { messaging, supplierEmail };
}
