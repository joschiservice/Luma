import '@luma/identity/http';

import {
  apiContract,
  collectionQueryIssue,
  inboxCatalog,
} from '@luma/api-contract';
import type { HttpContext } from '@luma/identity/http';
import { ServiceError, unavailable } from '@luma/platform';
import { implement } from '@orpc/server';
import type { FastifyRequest } from 'fastify';

import type { DocumentService } from '../application/documents.js';
import type { MessagingService } from '../application/messaging.js';
import type { Replies } from '../application/replies.js';

/**
 * Checks conditions and grouping against the inbox catalog, which offers structured thread
 * properties only. Throws a 400 error naming the first invalid
 * condition ("Condition 2: …") or the grouping.
 */
function validateThreadQuery(
  query: Parameters<typeof collectionQueryIssue>[1],
) {
  const message = collectionQueryIssue(inboxCatalog, query);
  if (message)
    throw Object.assign(new Error(message), { statusCode: 400, expose: true });
}

/**
 * Registers tenant-authenticated inbox reads and permission-gated thread work. Replies and
 * documents answer 503 when their services are not composed.
 */
export function messagingRoutes(
  service?: MessagingService,
  replies?: Replies,
  documents?: DocumentService,
) {
  function use(request: FastifyRequest) {
    if (!request.tenantContext)
      throw new ServiceError(401, 'UNAUTHENTICATED', 'Sign in to continue');
    if (!service)
      throw unavailable('The inbox is unavailable. Try again later.');

    return { context: request.tenantContext, service };
  }

  function useReplies(request: FastifyRequest) {
    const { context } = use(request);
    if (!replies)
      throw unavailable('Replies are unavailable. Try again later.');

    return { context, replies };
  }

  function useDocuments(request: FastifyRequest) {
    const { context } = use(request);
    if (!documents)
      throw unavailable('Documents are unavailable. Try again later.');

    return { context, documents };
  }

  const os = implement(apiContract.messaging).$context<HttpContext>();

  return os.router({
    mailboxes: os.mailboxes.handler(async ({ context: { request } }) => {
      const s = use(request);

      return await s.service.mailboxes(s.context);
    }),
    updateMailbox: os.updateMailbox.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.updateMailbox(
          s.context,
          params.connectionId,
          body,
        );
      },
    ),
    addRule: os.addRule.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.addRule(s.context, params.connectionId, body);
      },
    ),
    removeRule: os.removeRule.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.removeRule(
          s.context,
          params.connectionId,
          params.ruleId,
          body.id,
        );
      },
    ),
    syncMailbox: os.syncMailbox.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.service.syncMailbox(s.context, params.connectionId);
      },
    ),
    threads: os.threads.handler(
      async ({ context: { request }, input: { query } }) => {
        const s = use(request);
        validateThreadQuery(query);

        return await s.service.threads(s.context, query);
      },
    ),
    thread: os.thread.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.service.thread(s.context, params.threadId);
      },
    ),
    recordThreads: os.recordThreads.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = use(request);

        return await s.service.recordThreads(
          s.context,
          params.kind,
          params.recordId,
        );
      },
    ),
    assign: os.assign.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.assign(s.context, params.threadId, body);
      },
    ),
    setDeadline: os.setDeadline.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.setDeadline(s.context, params.threadId, body);
      },
    ),
    setStatus: os.setStatus.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.setStatus(s.context, params.threadId, body);
      },
    ),
    addNote: os.addNote.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.addNote(s.context, params.threadId, body);
      },
    ),
    link: os.link.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.link(s.context, params.threadId, body);
      },
    ),
    unlink: os.unlink.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.unlink(
          s.context,
          params.threadId,
          params.linkId,
          body.id,
        );
      },
    ),
    removeMessageText: os.removeMessageText.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = use(request);

        return await s.service.removeMessageText(
          s.context,
          params.threadId,
          params.messageId,
          body.id,
        );
      },
    ),
    document: os.document.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = useDocuments(request);

        return await s.documents.document(s.context, params.documentId);
      },
    ),
    readDocument: os.readDocument.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = useDocuments(request);

        return await s.documents.readDocument(
          s.context,
          params.documentId,
          body.id,
        );
      },
    ),
    addFact: os.addFact.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = useDocuments(request);

        return await s.documents.addFact(s.context, params.documentId, body);
      },
    ),
    reviewFact: os.reviewFact.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = useDocuments(request);

        return await s.documents.reviewFact(s.context, params.factId, body);
      },
    ),
    draft: os.draft.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = useReplies(request);

        return await s.replies.draft(s.context, params.threadId, body);
      },
    ),
    updateOutbound: os.updateOutbound.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = useReplies(request);

        return await s.replies.update(s.context, params.outboundId, body);
      },
    ),
    requestOutbound: os.requestOutbound.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = useReplies(request);

        return await s.replies.request(s.context, params.outboundId, body);
      },
    ),
    decideOutbound: os.decideOutbound.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = useReplies(request);

        return await s.replies.decide(s.context, params.outboundId, body);
      },
    ),
    sendOutbound: os.sendOutbound.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = useReplies(request);

        return await s.replies.send(s.context, params.outboundId, body);
      },
    ),
    checkOutbound: os.checkOutbound.handler(
      async ({ context: { request }, input: { params } }) => {
        const s = useReplies(request);

        return await s.replies.check(s.context, params.outboundId);
      },
    ),
    discardOutbound: os.discardOutbound.handler(
      async ({ context: { request }, input: { params, body } }) => {
        const s = useReplies(request);

        return await s.replies.discard(s.context, params.outboundId, body);
      },
    ),
  });
}
