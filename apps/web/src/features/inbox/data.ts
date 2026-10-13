import type {
  AssignInput,
  DeadlineInput,
  DocumentDetail,
  FactInput,
  FactReviewInput,
  LinkedRecordKind,
  MailboxRuleInput,
  MailboxSettingsInput,
  NoteInput,
  OutboundDecisionInput,
  OutboundInput,
  StatusInput,
  ThreadDetail,
  ThreadLinkInput,
  ThreadView,
} from '@luma/api-contract';
import { threadViewSchema } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';

import { IdentityError } from '../../kit/identity/data';
import { requestErrorMessage } from '../../kit/identity/errors';
import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient().messaging;

type ThreadPage = Awaited<ReturnType<typeof api.threads>>;

/** Polling interval used beside the live stream, so an interrupted stream still converges. */
const inboxPollMs = 30_000;

/**
 * URL state of the inbox. `thread` keeps the open thread so links and Back restore it; search text
 * stays in the URL because it only names what the reader looks for, not message content.
 */
export const inboxSearch = z.object({
  view: threadViewSchema.optional().catch(undefined),
  connectionId: z.string().uuid().optional().catch(undefined),
  q: z.string().max(200).optional().catch(undefined),
  thread: z.string().uuid().optional().catch(undefined),
});

export type InboxSearch = z.infer<typeof inboxSearch>;

/** The list filters that define which threads are shown; changing them restarts paging. */
export function inboxFilters(search: InboxSearch) {
  return {
    view: search.view ?? ('open' satisfies ThreadView),
    connectionId: search.connectionId,
    q: search.q?.trim() || undefined,
  };
}

/** Caches every messaging read of one workspace, so commands and live events refresh them together. */
export const messagingKey = (organizationId: string) =>
  ['private', 'organization', organizationId, 'messaging'] as const;

/** Lists connected mailboxes with their reading state, settings and rules. */
export const mailboxesOptions = (organizationId: string) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: [...messagingKey(organizationId), 'mailboxes'],
    refetchInterval: inboxPollMs,
    queryFn: ({ signal }) =>
      api.mailboxes({ params: { organizationId } }, { signal }),
  });

/**
 * Pages through threads for the given filters, newest activity first. The first page carries the
 * view counts. Polls as a fallback for the live stream.
 */
export const threadsOptions = (
  organizationId: string,
  filters: ReturnType<typeof inboxFilters>,
) =>
  infiniteQueryOptions({
    ...privateQueryDefaults,
    queryKey: [...messagingKey(organizationId), 'threads', filters],
    refetchInterval: inboxPollMs,
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: ThreadPage) => page.nextCursor ?? undefined,
    queryFn: ({ signal, pageParam }): Promise<ThreadPage> =>
      api.threads(
        {
          params: { organizationId },
          query: {
            view: filters.view,
            limit: 50,
            ...(filters.connectionId
              ? { connectionId: filters.connectionId }
              : {}),
            ...(filters.q ? { q: filters.q } : {}),
            ...(pageParam ? { cursor: pageParam } : {}),
          },
        },
        { signal },
      ),
  });

/**
 * Reads one thread with messages, links, notes, timeline, documents and replies. Polls faster
 * while a reply is being sent, so its confirmation appears without a manual refresh.
 */
export const threadOptions = (organizationId: string, threadId: string) =>
  queryOptions<ThreadDetail>({
    ...privateQueryDefaults,
    queryKey: [...messagingKey(organizationId), 'thread', threadId],
    refetchOnWindowFocus: 'always',
    refetchInterval: (query) =>
      query.state.data?.outbound.some((reply) => reply.state === 'sending')
        ? 5000
        : inboxPollMs,
    queryFn: ({ signal }): Promise<ThreadDetail> =>
      api.thread({ params: { organizationId, threadId } }, { signal }),
  });

/** Lists threads with an active link to one record; suggested links are left out. */
export const recordThreadsOptions = (
  organizationId: string,
  kind: LinkedRecordKind,
  recordId: string,
) =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: [...messagingKey(organizationId), 'record', kind, recordId],
    refetchInterval: inboxPollMs,
    queryFn: ({ signal }) =>
      api.recordThreads(
        { params: { organizationId, kind, recordId } },
        { signal },
      ),
  });

/** Reads a document's source representation beside the facts proposed from it. */
export const documentOptions = (organizationId: string, documentId: string) =>
  queryOptions<DocumentDetail>({
    ...privateQueryDefaults,
    queryKey: [...messagingKey(organizationId), 'document', documentId],
    refetchInterval: (query) =>
      ['pending', 'reading'].includes(query.state.data?.document.state ?? '')
        ? 5000
        : inboxPollMs,
    queryFn: ({ signal }): Promise<DocumentDetail> =>
      api.document({ params: { organizationId, documentId } }, { signal }),
  });

/** How a failed read should be presented. */
export type ReadFailure = 'signin' | 'access' | 'missing' | 'unavailable';

/**
 * Classifies a failed read: 401 asks the person to sign in again, 403 means their role no longer
 * allows it, 404 that the item is gone or hidden; everything else is temporarily unavailable.
 */
export function readFailure(error: unknown): ReadFailure | undefined {
  if (!error) return undefined;
  if (!(error instanceof IdentityError)) return 'unavailable';
  if (error.status === 401) return 'signin';
  if (error.status === 403) return 'access';
  if (error.status === 404) return 'missing';

  return 'unavailable';
}

/**
 * Reports whether a command's outcome is unknown: the request may or may not have been applied,
 * such as after a network failure or a server error. Rejections with a 4xx status are definite.
 */
export function uncertainOutcome(error: unknown) {
  return (
    !!error &&
    (!(error instanceof IdentityError) ||
      error.status === 0 ||
      error.status >= 500)
  );
}

/** Explains a failed command; an unknown outcome says that retrying repeats the same request. */
export function commandError(error: unknown) {
  return uncertainOutcome(error)
    ? m.messaging_error_uncertain()
    : requestErrorMessage(error, m.messaging_error_rejected());
}

/**
 * Runs a messaging command with a client-generated command ID. The ID is created once per form
 * and kept until the command succeeds, so a retry after an unknown outcome repeats the exact same
 * request body and ID, and the server applies it at most once. The form stays locked while the
 * outcome is unknown; only the retry is offered. Success refreshes every messaging read of the
 * workspace and starts a new ID for the next command of the same form.
 */
export function useInboxCommand<T, R>(
  organizationId: string,
  save: (body: T, id: string) => Promise<R>,
  saved?: (value: R) => void,
) {
  const client = useQueryClient();
  const [id, setId] = useState(() => crypto.randomUUID());
  const mutation = useMutation({
    mutationFn: (request: { body: T; id: string }) =>
      save(request.body, request.id),
    onSuccess: (value) => {
      setId(crypto.randomUUID());
      void client.invalidateQueries({
        queryKey: messagingKey(organizationId),
      });
      saved?.(value);
    },
  });
  const uncertain = mutation.isError && uncertainOutcome(mutation.error);
  const last = mutation.variables;

  return {
    isPending: mutation.isPending,
    isError: mutation.isError,
    error: mutation.error,
    data: mutation.data,
    reset: mutation.reset,
    /** The body of the last request, while its outcome is unknown or after it failed. */
    pendingBody: last?.body,
    uncertain,
    locked: mutation.isPending || uncertain,
    errorText: mutation.error ? commandError(mutation.error) : undefined,
    /** Sends `body` with this form's command ID; while the last outcome is unknown, repeats it. */
    submit: (body: T) =>
      mutation.mutate(uncertain && last ? last : { body, id }),
    /** Repeats the last request exactly, after an unknown outcome. */
    retry: () => {
      if (last) mutation.mutate(last);
    },
  };
}

type Org = { organizationId: string };

/** Changes mailbox settings at the revision the reader saw. */
export const updateMailbox = (
  { organizationId }: Org,
  connectionId: string,
  body: MailboxSettingsInput,
) => api.updateMailbox({ params: { organizationId, connectionId }, body });

/** Adds a rule that decides which messages Luma reads; the rule ID makes retries safe. */
export const addRule = (
  { organizationId }: Org,
  connectionId: string,
  body: MailboxRuleInput,
) => api.addRule({ params: { organizationId, connectionId }, body });

/** Removes a rule; threads already read stay. */
export const removeRule = (
  { organizationId }: Org,
  connectionId: string,
  ruleId: string,
  id: string,
) =>
  api.removeRule({
    params: { organizationId, connectionId, ruleId },
    body: { id },
  });

/** Schedules a read of the mailbox within seconds; does not wait for it. */
export const syncMailbox = ({ organizationId }: Org, connectionId: string) =>
  api.syncMailbox({ params: { organizationId, connectionId } });

/** Assigns a thread, or clears its owner with `ownerId: null`. */
export const assignThread = (
  { organizationId }: Org,
  threadId: string,
  body: AssignInput,
) => api.assign({ params: { organizationId, threadId }, body });

/** Sets a reply deadline, or returns to the automatic one with `replyDueAt: null`. */
export const setDeadline = (
  { organizationId }: Org,
  threadId: string,
  body: DeadlineInput,
) => api.setDeadline({ params: { organizationId, threadId }, body });

/** Changes whether the thread is open, waiting or closed. */
export const setStatus = (
  { organizationId }: Org,
  threadId: string,
  body: StatusInput,
) => api.setStatus({ params: { organizationId, threadId }, body });

/** Adds an internal note; notes are never sent. */
export const addNote = (
  { organizationId }: Org,
  threadId: string,
  body: NoteInput,
) => api.addNote({ params: { organizationId, threadId }, body });

/** Links the thread to a record, or confirms a suggested link to the same record. */
export const linkRecord = (
  { organizationId }: Org,
  threadId: string,
  body: ThreadLinkInput,
) => api.link({ params: { organizationId, threadId }, body });

/** Removes a record link; Luma does not add the same automatic link again. */
export const unlinkRecord = (
  { organizationId }: Org,
  threadId: string,
  linkId: string,
  id: string,
) => api.unlink({ params: { organizationId, threadId, linkId }, body: { id } });

/** Removes a message's text and attachment content, keeping metadata, links and reviewed facts. */
export const removeMessageText = (
  { organizationId }: Org,
  threadId: string,
  messageId: string,
  id: string,
) =>
  api.removeMessageText({
    params: { organizationId, threadId, messageId },
    body: { id },
  });

/** Reads a failed document again; reviewed facts are kept. */
export const readDocument = (
  { organizationId }: Org,
  documentId: string,
  id: string,
) => api.readDocument({ params: { organizationId, documentId }, body: { id } });

/** Adds a fact that points to text or cells in the document. */
export const addFact = (
  { organizationId }: Org,
  documentId: string,
  body: FactInput,
) => api.addFact({ params: { organizationId, documentId }, body });

/** Confirms, corrects or rejects a fact. */
export const reviewFact = (
  { organizationId }: Org,
  factId: string,
  body: FactReviewInput,
) => api.reviewFact({ params: { organizationId, factId }, body });

/** Drafts a reply from the current state of the thread's linked records. */
export const draftReply = (
  { organizationId }: Org,
  threadId: string,
  id: string,
) => api.draft({ params: { organizationId, threadId }, body: { id } });

/** Saves edits to a draft at the revision the reader saw. */
export const updateOutbound = (
  { organizationId }: Org,
  outboundId: string,
  body: OutboundInput,
) => api.updateOutbound({ params: { organizationId, outboundId }, body });

/** Sends a reply at once, or requests approval when it is consequential. */
export const requestOutbound = (
  { organizationId }: Org,
  outboundId: string,
  id: string,
) =>
  api.requestOutbound({ params: { organizationId, outboundId }, body: { id } });

/** Approves or rejects the exact reply the approver reviewed. */
export const decideOutbound = (
  { organizationId }: Org,
  outboundId: string,
  body: OutboundDecisionInput,
) => api.decideOutbound({ params: { organizationId, outboundId }, body });

/** Sends an approved reply; repeating returns the recorded result and never sends twice. */
export const sendOutbound = (
  { organizationId }: Org,
  outboundId: string,
  id: string,
) => api.sendOutbound({ params: { organizationId, outboundId }, body: { id } });

/** Reads the thread again to settle an uncertain send; never sends. */
export const checkOutbound = (
  { organizationId }: Org,
  outboundId: string,
  id: string,
) =>
  api.checkOutbound({ params: { organizationId, outboundId }, body: { id } });

/** Discards a draft or a reply waiting for approval. */
export const discardOutbound = (
  { organizationId }: Org,
  outboundId: string,
  id: string,
) =>
  api.discardOutbound({
    params: { organizationId, outboundId },
    body: { id },
  });

/** Downloads the exact reviewed supplier PDF retained with an outgoing inbox message. */
export async function downloadSupplierPdf(
  organizationId: string,
  purchaseOrderId: string,
  outboundId: string,
) {
  const file = await createWebApiClient().procurementEmail.document({
    params: { organizationId, purchaseOrderId, outboundId },
  });
  const bytes = Uint8Array.from(atob(file.base64), (char) =>
    char.charCodeAt(0),
  );
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
