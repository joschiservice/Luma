import type { AuditEntry } from '@luma/audit';
import type { Permission, TenantContext } from '@luma/identity';
import { requirePermission, requireTenant } from '@luma/identity';
import { conflict, forbidden, invalid, notFound } from '@luma/platform';

import type { ReadOutcome } from '../domain/documents.js';
import {
  contentCheck,
  documentFormat,
  fetchFailure,
  maxReadAttempts,
} from '../domain/documents.js';
import type {
  FactDocument,
  FactLocator,
  FactMatch,
  FactRecord,
  FactValue,
  ProposedFact,
} from '../domain/facts.js';
import {
  byPosition,
  compareFacts,
  factKey,
  initialStatus,
  locateQuote,
  quoteAt,
  recordKindFor,
  removedFacts,
  reviewFact,
  validValue,
  valueKey,
} from '../domain/facts.js';
import type { MatchLookups } from '../domain/matching.js';
import { lookupKeys, matchFact } from '../domain/matching.js';
import { tableFacts } from '../domain/tables.js';
import { maxDocumentBytes } from '../domain/threads.js';
import type {
  AttachmentReader,
  DocumentDirectory,
  FactExtractor,
  Represent,
} from './document-ports.js';
import type { DocumentDetail, FactView } from './document-views.js';
import { documentDetail, factRecords, factView } from './document-views.js';
import type {
  ExtractionNote,
  FactRow,
  StoredRepresentation,
} from './documents-store.js';
import type { RecordDirectory } from './ports.js';
import type {
  DocumentRow,
  MessagingStore,
  MessagingTransaction,
} from './store.js';
import { recordKey, recordPermission } from './views.js';

export interface DocumentDependencies {
  store: MessagingStore;
  directory: RecordDirectory;
  documents: DocumentDirectory;
  /** Without it, documents stay pending; people can still read stored ones. */
  attachments?: AttachmentReader | undefined;
  represent: Represent;
  extractor: FactExtractor;
  refreshContext(context: TenantContext): Promise<TenantContext>;
  now(): Date;
  id(): string;
  digest(value: unknown): string;
  /** Lower-case hex SHA-256 of content. */
  sha256(bytes: Uint8Array): string;
  log(message: string, error?: unknown): void;
  /** Documents read per workspace pass; defaults to 3. */
  batch?: number | undefined;
}

export interface FactInput {
  id: string;
  value: FactValue;
  locator: FactLocator;
}

export interface FactReviewInput {
  id: string;
  outcome: 'confirm' | 'correct' | 'reject';
  correction?: { value: FactValue; record: FactRecord | null } | undefined;
}

/** Only content errors are logged, by name; documents and model text never reach logs. */
const safeError = (error: unknown) =>
  new Error(error instanceof Error ? error.name : 'Error');

/**
 * Reads documents attached to messages and keeps their facts reviewable. A background pass
 * fetches each pending document through the mailbox connection, recognizes repeated content,
 * builds a representation, proposes facts from tables and, when configured, a model, and
 * matches them to records. People confirm, correct or reject facts; facts never authorize an
 * action.
 */
export function createDocuments(deps: DocumentDependencies) {
  const batch = deps.batch ?? 3;

  async function authorize(context: TenantContext, permission: Permission) {
    requireTenant(context, context.tenantId);
    const fresh = await deps.refreshContext(context);
    requireTenant(fresh, context.tenantId);
    requirePermission(fresh, permission);
    if (fresh.actor.id !== context.actor.id)
      throw forbidden('Sign in again to continue.');

    return fresh;
  }

  /** Runs a write once per command ID; an exact retry skips the write, a changed one fails. */
  async function command(
    context: TenantContext,
    id: string,
    request: unknown,
    operation: (tx: MessagingTransaction) => Promise<void>,
  ) {
    const digest = deps.digest({ actorId: context.actor.id, request });
    await deps.store.transaction(context.tenantId, async (tx) => {
      const prior = await tx.commands.get(id);
      if (prior) {
        if (prior.digest !== digest)
          throw conflict(
            'This request ID was already used for another change. Refresh and try again.',
          );

        return;
      }
      await operation(tx);
      await tx.commands.save(id, digest, { ok: true });
    });
  }

  function audit(
    context: TenantContext,
    input: {
      type: string;
      commandId: string;
      subjectId: string;
      details: Record<string, string>;
    },
  ): AuditEntry {
    return {
      id: deps.id(),
      tenantId: context.tenantId,
      eventKey: `messaging:${input.type}:${input.commandId}`,
      eventType: `messaging.${input.type}`,
      schemaVersion: 1,
      occurredAt: deps.now().toISOString(),
      actor: { kind: 'user', id: context.actor.id },
      correlationId: context.requestId,
      proposalId: input.subjectId,
      actionHash: deps.digest({ type: input.type, ...input.details }),
      evidenceRefs: [input.subjectId],
      details: { commandId: input.commandId, ...input.details },
    };
  }

  /** What other owners hold for the facts' keys, plus the thread's rule suppliers. */
  async function lookups(
    context: TenantContext,
    threadId: string,
    values: readonly FactValue[],
  ): Promise<MatchLookups> {
    const keys = lookupKeys(values);
    const [references, customers, skus, suppliers, links] = await Promise.all([
      keys.references.length
        ? deps.directory.references(context, keys.references)
        : Promise.resolve([]),
      keys.emails.length
        ? deps.directory.customers(context, keys.emails)
        : Promise.resolve([]),
      keys.skus.length
        ? deps.documents.skus(context, keys.skus)
        : Promise.resolve(new Set<string>()),
      keys.supplierNames.length
        ? deps.documents.suppliers(context, keys.supplierNames)
        : Promise.resolve([]),
      values.some((v) => v.kind === 'party' && v.role === 'supplier')
        ? deps.store.transaction(context.tenantId, (tx) =>
            tx.links.forThreads([threadId]),
          )
        : Promise.resolve([]),
    ]);

    return {
      skus,
      references: references.flatMap((r) =>
        r.kind === 'order' || r.kind === 'purchase_order'
          ? [{ kind: r.kind, id: r.id, key: r.key }]
          : [],
      ),
      customers,
      suppliers,
      ruleSuppliers: links
        .filter(
          (l) =>
            l.kind === 'supplier' &&
            l.state === 'active' &&
            l.method === 'rule',
        )
        .map((l) => l.recordId),
    };
  }

  async function labelsFor(context: TenantContext, facts: readonly FactRow[]) {
    const records = factRecords(facts);

    return records.length
      ? deps.directory.labels(context, records)
      : new Map<string, string>();
  }

  /** Ends a claimed read if this runner still holds it; the attempt count fences other runners. */
  async function finish(
    tx: MessagingTransaction,
    claimed: DocumentRow,
    change: Partial<DocumentRow>,
    content?: {
      bytes: Uint8Array | null;
      representation: StoredRepresentation | null;
    },
  ) {
    const current = await tx.reading.get(claimed.id, true);
    if (
      !current ||
      current.state !== 'reading' ||
      current.attempts !== claimed.attempts
    )
      return false;
    await tx.reading.update(
      { ...current, ...change, updatedAt: deps.now().toISOString() },
      content,
    );

    return true;
  }

  /** Records a read that produced no representation. */
  function settle(
    tenantId: string,
    claimed: DocumentRow,
    outcome: ReadOutcome,
    sha256: string | null = null,
  ) {
    return deps.store.transaction(tenantId, (tx) =>
      finish(
        tx,
        claimed,
        outcome.state === 'retry'
          ? // Stays claimed until its retry wait passes; then it is read again or marked failed.
            {
              state: claimed.attempts >= maxReadAttempts ? 'failed' : 'reading',
              failure: outcome.failure,
            }
          : { state: outcome.state, failure: outcome.failure, sha256 },
      ),
    );
  }

  /** Facts a model proposes, kept only where their quote is in the document. */
  async function modelFacts(
    context: TenantContext,
    claimed: DocumentRow,
    representation: StoredRepresentation['representation'],
    table: readonly ProposedFact[],
  ): Promise<{ facts: ProposedFact[]; note: ExtractionNote }> {
    if (!deps.extractor.available)
      return {
        facts: [],
        note: {
          state: 'unavailable',
          reason: deps.extractor.reason,
          discarded: 0,
          model: null,
        },
      };
    const result = await deps.extractor.extract(context, {
      filename: claimed.filename,
      representation,
    });
    if (!result.ok)
      return {
        facts: [],
        note: {
          state: 'failed',
          reason: result.reason,
          discarded: 0,
          model: null,
        },
      };
    const known = new Set(table.map((fact) => valueKey(fact.value)));
    const tableLines = table.some((fact) => fact.value.kind === 'line');
    const facts: ProposedFact[] = [];
    let discarded = result.invalid;
    for (const fact of result.facts) {
      const located = locateQuote(representation, fact.quote, fact);
      if (!located) {
        discarded += 1;
        continue;
      }
      // The table reading is exact; the model adds only what it did not find.
      if (
        known.has(valueKey(fact.value)) ||
        (tableLines && fact.value.kind === 'line')
      )
        continue;
      facts.push({
        value: fact.value,
        locator: located.locator,
        quote: located.quote,
        confidence: fact.confident ? 'high' : 'low',
        origin: 'model',
      });
    }

    return {
      facts,
      note: {
        state: 'completed',
        reason: discarded
          ? `${discarded} proposed ${discarded === 1 ? 'fact was' : 'facts were'} left out because ${discarded === 1 ? 'it' : 'they'} could not be found in the document.`
          : null,
        discarded,
        model: result.model,
      },
    };
  }

  /** Reads one claimed document to its end state. */
  async function read(context: TenantContext, claimed: DocumentRow) {
    const tenantId = context.tenantId;
    const now = deps.now();
    if (claimed.attempts > maxReadAttempts)
      return settle(tenantId, claimed, {
        state: 'failed',
        failure: 'read_failed',
      });
    if (claimed.purgedAt || Date.parse(claimed.retainUntil) <= now.getTime())
      return settle(tenantId, claimed, {
        state: 'failed',
        failure: 'content_removed',
      });
    const format = documentFormat(claimed);
    if (!format)
      return settle(tenantId, claimed, {
        state: 'unsupported',
        failure: 'unsupported_type',
      });
    const source = await deps.store.transaction(tenantId, async (tx) => {
      const message = await tx.messages.get(claimed.messageId);
      const thread = await tx.threads.get(claimed.threadId);

      return message && thread ? { message, thread } : null;
    });
    const ref = source?.message.document.attachments.find(
      (a) => a.attachment.externalId === claimed.providerAttachmentId,
    );
    if (!source || !ref)
      return settle(tenantId, claimed, {
        state: 'failed',
        failure: 'not_found',
      });
    let fetched: Awaited<ReturnType<AttachmentReader['read']>>;
    try {
      fetched = await deps.attachments!.read(
        context,
        source.thread.connectionId,
        {
          // Messages are stored by their provider ID; providers scope them to the mailbox.
          message: {
            externalId: source.message.providerMessageId,
            scopeKey: '',
          },
          attachment: ref.attachment,
          maxBytes: maxDocumentBytes,
        },
      );
    } catch (error) {
      deps.log('Reading an attachment failed; retrying.', safeError(error));
      fetched = { ok: false, code: 'internal' };
    }
    if (!fetched.ok)
      return settle(tenantId, claimed, fetchFailure(fetched.code));
    const bytes = fetched.bytes;
    const sha256 = deps.sha256(bytes);
    const checked = contentCheck({
      size: bytes.length,
      sha256,
      reportedSha256: fetched.sha256,
    });
    if (checked) return settle(tenantId, claimed, checked, sha256);

    // The same content already read in the workspace is reviewed there, not again.
    const duplicate = await deps.store.transaction(tenantId, async (tx) => {
      await tx.reading.lockContent(sha256);
      const original = await tx.reading.original(sha256, claimed.id);
      if (original)
        await finish(tx, claimed, {
          state: 'duplicate',
          duplicateOf: original.id,
          sha256,
          failure: null,
        });

      return !!original;
    });
    if (duplicate) return;

    let built: Awaited<ReturnType<Represent>>;
    try {
      built = await deps.represent(bytes, {
        format,
        filename: claimed.filename,
      });
    } catch (error) {
      deps.log('A document could not be read.', safeError(error));

      return settle(
        tenantId,
        claimed,
        { state: 'failed', failure: 'parse_failed' },
        sha256,
      );
    }
    if (!built.ok) return settle(tenantId, claimed, built.outcome, sha256);
    const representation = built.representation;
    const table =
      representation.kind === 'sheets' ? tableFacts(representation.sheets) : [];
    const model = await modelFacts(context, claimed, representation, table);
    const seen = new Set<string>();
    const proposed = [...table, ...model.facts]
      .filter((fact) => {
        const key = factKey(fact.origin, fact.value, fact.locator, deps.digest);
        if (seen.has(key)) return false;
        seen.add(key);

        return true;
      })
      .sort(byPosition);
    const lookup = await lookups(
      context,
      claimed.threadId,
      proposed.map((fact) => fact.value),
    );

    await deps.store.transaction(tenantId, async (tx) => {
      await tx.reading.lockContent(sha256);
      const original = await tx.reading.original(sha256, claimed.id);
      if (original) {
        await finish(tx, claimed, {
          state: 'duplicate',
          duplicateOf: original.id,
          sha256,
          failure: null,
        });

        return;
      }
      const current = await tx.reading.get(claimed.id, true);
      if (
        !current ||
        current.state !== 'reading' ||
        current.attempts !== claimed.attempts
      )
        return;
      const previous = await tx.reading.previousVersion(current);
      const prior = previous
        ? (await tx.reading.facts([previous.id])).map((row) => ({
            value: row.document.value,
            status: row.status,
            review: row.document.review,
            row,
          }))
        : null;
      const compared = compareFacts(proposed, prior);
      const at = deps.now().toISOString();
      for (const [index, fact] of proposed.entries()) {
        const { change, carried } = compared[index]!;
        let match = matchFact(fact.value, lookup);
        // A carried confirmation keeps the record the person chose.
        if (carried?.status === 'confirmed' && match.state === 'ambiguous')
          match = carried.prior.row.document.match;
        const document: FactDocument = {
          value: fact.value,
          locator: fact.locator,
          quote: fact.quote,
          confidence: fact.confidence,
          match,
          origin: fact.origin,
          change,
          review: carried?.review ?? null,
        };
        await tx.reading.insertFact({
          id: deps.id(),
          documentId: claimed.id,
          factKey: factKey(fact.origin, fact.value, fact.locator, deps.digest),
          document,
          status: carried?.status ?? initialStatus(fact.confidence, match),
          createdAt: at,
          updatedAt: at,
        });
      }
      await finish(
        tx,
        claimed,
        {
          state: 'ready',
          sha256,
          failure: built.truncated ? 'truncated' : null,
          version: previous ? previous.version + 1 : 1,
          previousId: previous?.id ?? null,
        },
        {
          bytes,
          representation: {
            representation,
            truncated: built.truncated,
            extraction: model.note,
          },
        },
      );
    });
  }

  /** Loads a document with what its detail view needs. */
  async function detail(
    context: TenantContext,
    documentId: string,
  ): Promise<DocumentDetail> {
    const data = await deps.store.transaction(context.tenantId, async (tx) => {
      const document = await tx.reading.get(documentId);
      if (!document) throw notFound('Document not found');
      const message = await tx.messages.get(document.messageId);
      const facts = await tx.reading.facts([documentId]);
      const previous = document.previousId
        ? await tx.reading.facts([document.previousId])
        : [];

      return {
        document: document,
        receivedAt: message?.receivedAt ?? document.createdAt,
        stored: document.purgedAt
          ? null
          : await tx.reading.representation(documentId),
        facts,
        removed: removedFacts(
          facts.map((f) => ({ value: f.document.value })),
          previous.map((row) => ({
            value: row.document.value,
            status: row.status,
            row,
          })),
        ).map((entry) => entry.row),
      };
    });
    const labels = await labelsFor(context, [...data.facts, ...data.removed]);

    return documentDetail(context, {
      ...data,
      labels,
      extractor: deps.extractor,
    });
  }

  /** The match for a corrected value: the chosen record, or a fresh exact match. */
  async function correctionMatch(
    context: TenantContext,
    fact: FactRow,
    threadId: string,
    correction: { value: FactValue; record: FactRecord | null },
  ): Promise<FactMatch> {
    if (!correction.record) {
      const kind = recordKindFor(correction.value);
      if (correction.value.kind !== 'line' && kind === null)
        return { state: 'not_applicable', record: null, candidates: [] };

      return matchFact(
        correction.value,
        await lookups(context, threadId, [correction.value]),
      );
    }
    const record = correction.record;
    if (recordKindFor(correction.value) !== record.kind)
      throw invalid('This record cannot be what the fact refers to.');
    const candidate = [
      ...fact.document.match.candidates,
      ...(fact.document.match.record ? [fact.document.match.record] : []),
    ].some((c) => c.kind === record.kind && c.id === record.id);
    if (!candidate) {
      requirePermission(context, recordPermission[record.kind]);
      const labels = await deps.directory.labels(context, [record]);
      if (!labels.has(recordKey(record)))
        throw notFound('The record was not found.');
    }

    return { state: 'matched', record, candidates: [] };
  }

  return {
    /**
     * Reads pending documents of mailboxes read as the context's member, a few per pass. Runs
     * after the member's mailboxes in the background pass.
     */
    async pass(context: TenantContext) {
      if (!deps.attachments) return;
      const claimed = await deps.store.transaction(context.tenantId, (tx) =>
        tx.reading.claim(context.actor.id, deps.now().toISOString(), batch),
      );
      for (const document of claimed)
        await read(context, document).catch((error: unknown) =>
          // The claim stays until its retry wait passes, so the document is read again.
          deps.log('Reading a document failed; retrying.', safeError(error)),
        );
    },
    service: {
      /** Reads a document beside its facts. Requires `messages.read`. */
      async document(context: TenantContext, documentId: string) {
        context = await authorize(context, 'messages.read');

        return detail(context, documentId);
      },
      /** Reads a failed document again; reviewed facts are kept. Requires `messages.manage`. */
      async readDocument(
        context: TenantContext,
        documentId: string,
        commandId: string,
      ) {
        context = await authorize(context, 'messages.manage');
        await command(
          context,
          commandId,
          { command: 'read_document', documentId },
          async (tx) => {
            const document = await tx.reading.get(documentId, true);
            if (!document) throw notFound('Document not found');
            if (document.state === 'pending' || document.state === 'reading')
              return;
            if (document.state !== 'failed')
              throw conflict(
                'Only documents that could not be read can be read again.',
              );
            if (document.purgedAt)
              throw conflict(
                'The document’s content was removed, so it cannot be read again.',
              );
            await tx.reading.update({
              ...document,
              state: 'pending',
              failure: null,
              attempts: 0,
              updatedAt: deps.now().toISOString(),
            });
            await tx.audit(
              audit(context, {
                type: 'document.read_requested',
                commandId,
                subjectId: documentId,
                details: { documentId, threadId: document.threadId },
              }),
            );
          },
        );

        return detail(context, documentId);
      },
      /**
       * Adds a fact someone found. The locator must point to text or cells in the document; the
       * quote is taken from there. Requires `messages.manage`.
       */
      async addFact(
        context: TenantContext,
        documentId: string,
        input: FactInput,
      ) {
        context = await authorize(context, 'messages.manage');
        if (!validValue(input.value))
          throw invalid('This fact is not complete.');
        const source = await deps.store.transaction(
          context.tenantId,
          async (tx) => {
            const document = await tx.reading.get(documentId);
            if (!document) throw notFound('Document not found');

            return {
              document: document,
              stored: document.purgedAt
                ? null
                : await tx.reading.representation(documentId),
            };
          },
        );
        if (source.document.state !== 'ready')
          throw conflict('Facts can be added only to documents Luma has read.');
        if (!source.stored)
          throw conflict('The document’s content was removed.');
        const quote = quoteAt(source.stored.representation, input.locator);
        if (!quote) throw invalid('The selection is not in the document.');
        const match = matchFact(
          input.value,
          await lookups(context, source.document.threadId, [input.value]),
        );
        await command(
          context,
          input.id,
          {
            command: 'add_fact',
            documentId,
            value: input.value,
            locator: input.locator,
          },
          async (tx) => {
            const document = await tx.reading.get(documentId, true);
            if (!document || document.state !== 'ready' || document.purgedAt)
              throw conflict('This document changed. Refresh and try again.');
            const facts = await tx.reading.facts([documentId]);
            const previous = document.previousId
              ? await tx.reading.facts([document.previousId])
              : null;
            const added = { value: input.value, locator: input.locator };
            const ordered = [...facts.map((f) => f.document), added].sort(
              byPosition,
            );
            const change =
              compareFacts(
                ordered,
                previous?.map((row) => ({
                  value: row.document.value,
                  status: row.status,
                  review: row.document.review,
                })) ?? null,
              )[ordered.indexOf(added)]?.change ?? null;
            const at = deps.now().toISOString();
            await tx.reading.insertFact({
              id: input.id,
              documentId,
              factKey: `manual:${input.id}`,
              document: {
                value: input.value,
                locator: input.locator,
                quote: quote,
                confidence: 'high',
                match,
                origin: 'manual',
                change,
                review: null,
              },
              status: initialStatus('high', match),
              createdAt: at,
              updatedAt: at,
            });
            await tx.audit(
              audit(context, {
                type: 'fact.added',
                commandId: input.id,
                subjectId: documentId,
                details: {
                  documentId,
                  factId: input.id,
                  kind: input.value.kind,
                },
              }),
            );
          },
        );

        return detail(context, documentId);
      },
      /**
       * Confirms, corrects or rejects a fact. Facts that need correction cannot be confirmed
       * unchanged, and a correction must resolve an ambiguous match. Requires `messages.manage`.
       */
      async reviewFact(
        context: TenantContext,
        factId: string,
        input: FactReviewInput,
      ): Promise<FactView> {
        context = await authorize(context, 'messages.manage');
        const loaded = await deps.store.transaction(
          context.tenantId,
          async (tx) => {
            const fact = await tx.reading.fact(factId);
            const document = fact
              ? await tx.reading.get(fact.documentId)
              : null;

            return fact && document ? { fact, document } : null;
          },
        );
        if (!loaded) throw notFound('Fact not found');
        const { fact, document } = loaded;
        const match =
          input.outcome === 'correct' && input.correction
            ? await correctionMatch(
                context,
                fact,
                document.threadId,
                input.correction,
              )
            : null;
        await command(
          context,
          input.id,
          { command: 'review_fact', factId, ...input },
          async (tx) => {
            const current = await tx.reading.fact(factId, true);
            if (!current) throw notFound('Fact not found');
            const at = deps.now().toISOString();
            const result = reviewFact(
              current,
              input.outcome === 'correct'
                ? {
                    outcome: 'correct',
                    value: input.correction!.value,
                    match: match!,
                  }
                : { outcome: input.outcome },
              context.actor.id,
              at,
            );
            if (!result.ok) {
              if (result.refusal === 'already_reviewed')
                throw conflict(
                  'This fact was already reviewed. Refresh to see it.',
                );
              if (result.refusal === 'needs_correction')
                throw conflict(
                  match?.state === 'ambiguous'
                    ? 'Several records match. Choose the one this fact refers to.'
                    : 'This fact needs a correction before it can be confirmed.',
                );
              throw invalid(
                result.refusal === 'kind_changed'
                  ? 'A correction must keep the kind of fact.'
                  : 'This fact is not complete.',
              );
            }
            await tx.reading.updateFact({
              ...current,
              document: result.document,
              status: result.status,
              updatedAt: at,
            });
            const outcome = result.document.review!.outcome;
            await tx.events.insert({
              id: deps.id(),
              threadId: document.threadId,
              type: 'fact_reviewed',
              actor: { kind: 'user', id: context.actor.id },
              details: {
                documentId: document.id,
                factId,
                kind: current.document.value.kind,
                outcome,
              },
              occurredAt: at,
            });
            await tx.audit(
              audit(context, {
                type: 'fact.reviewed',
                commandId: input.id,
                subjectId: document.id,
                details: {
                  documentId: document.id,
                  factId,
                  outcome,
                  kind: current.document.value.kind,
                },
              }),
            );
          },
        );
        const updated = await deps.store.transaction(context.tenantId, (tx) =>
          tx.reading.fact(factId),
        );

        return factView(
          context,
          updated!,
          await labelsFor(context, [updated!]),
        );
      },
    },
  };
}

export type DocumentService = ReturnType<typeof createDocuments>['service'];
