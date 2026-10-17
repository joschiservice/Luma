import {
  composeHeaders,
  findByMessageId,
  storeMessage,
  threadByReferences,
} from './messages.js';
import {
  bareId,
  baseSubject,
  type GmailContext,
  kinds,
  type LabelRecord,
  mailbox,
  type MailboxRecord,
  type MessageRecord,
  userLabels,
} from './model.js';

interface CommandAddress {
  address: string;
  name?: string | null | undefined;
}

export interface DeliverAttachment {
  filename: string;
  mimeType: string;
  /** Standard base64 content. */
  base64: string;
}

/**
 * The DMARC result Gmail's receiving servers record for a delivered message: `pass` for the
 * sender's own domain (the default), `fail` for a forged sender, `none` for no result.
 */
type SenderAuthenticationResult = 'pass' | 'fail' | 'none';

/** Merchant, supplier and customer actions on a simulated mailbox. */
export type GmailCommand =
  | {
      kind: 'bounce';
      message: string;
      recipient: string;
      status: string;
      authentication?: SenderAuthenticationResult | undefined;
    }
  | {
      kind: 'seed-mailbox';
      address: string;
      name: string;
      /** User labels to create when missing. */
      labels?: string[] | undefined;
    }
  | {
      /**
       * A message arrives in the mailbox. A message from the mailbox's own address is recorded as
       * sent from another mail client, such as the ERP's purchase-order email.
       */
      kind: 'deliver';
      from: CommandAddress;
      /** Recipients; defaults to the mailbox address. */
      to?: CommandAddress[] | undefined;
      cc?: CommandAddress[] | undefined;
      /** Defaults to a reply subject when `threadOf` is set. */
      subject?: string | undefined;
      text: string;
      html?: string | undefined;
      /** Gmail ID or RFC Message-ID of a message in this mailbox that this one answers. */
      threadOf?: string | undefined;
      /**
       * RFC Message-ID this one answers, which need not be in the mailbox; it sets In-Reply-To
       * and References, and the message joins the referenced thread when it is present.
       */
      inReplyTo?: string | undefined;
      /** RFC Message-ID; delivering the same ID again returns the stored message. */
      messageId?: string | undefined;
      /** User label names the mailbox's filters apply. */
      labels?: string[] | undefined;
      attachments?: DeliverAttachment[] | undefined;
      /** Delivery time in epoch milliseconds; defaults to the simulation time. */
      at?: number | undefined;
      /** Ignored for messages from the mailbox itself, which Gmail does not authenticate. */
      authentication?: SenderAuthenticationResult | undefined;
    };

export type GmailCommandResult =
  | { kind: 'mailbox'; address: string; name: string }
  | {
      kind: 'message';
      id: string;
      threadId: string;
      messageId: string;
      /** False when the Message-ID was already delivered. */
      created: boolean;
    };

/** Thrown for commands the mailbox cannot apply. */
class GmailCommandError extends Error {}

const address = (input: CommandAddress) => ({
  address: input.address.trim().toLowerCase(),
  name: input.name?.trim() || null,
});

/** Returns label IDs for user label names, creating missing labels. */
async function labelIds(context: GmailContext, names: string[]) {
  const labels = await userLabels(context);
  const ids: string[] = [];
  for (const name of names) {
    let label = labels.find(
      (item) => item.name.toLowerCase() === name.toLowerCase(),
    );
    if (!label) {
      label = {
        id: `Label_${await context.store.sequence('label')}`,
        name,
      };
      await context.store.put<LabelRecord>(kinds.label, label.id, label, {
        createdAt: context.now,
        updatedAt: context.now,
      });
      labels.push(label);
    }
    ids.push(label.id);
  }

  return ids;
}

async function original(context: GmailContext, reference: string) {
  const byId = await context.store.get<MessageRecord>(kinds.message, reference);

  return byId?.data ?? (await findByMessageId(context, bareId(reference)));
}

async function deliver(
  context: GmailContext,
  command: Extract<GmailCommand, { kind: 'deliver' }>,
): Promise<GmailCommandResult> {
  const messageId = command.messageId ? bareId(command.messageId) : null;
  if (messageId) {
    const existing = await findByMessageId(context, messageId);
    if (existing)
      return {
        kind: 'message',
        id: existing.id,
        threadId: existing.threadId,
        messageId: existing.messageId,
        created: false,
      };
  }
  const box = await mailbox(context);
  const from = address(command.from);
  if (!from.address.includes('@'))
    throw new GmailCommandError('The sender needs an email address');
  const parent = command.threadOf
    ? await original(context, command.threadOf)
    : undefined;
  if (command.threadOf && !parent)
    throw new GmailCommandError('The message to answer was not found');
  const subject =
    command.subject ??
    (parent
      ? /^\s*(re|aw)\s*:/i.test(parent.subject)
        ? parent.subject
        : `Re: ${parent.subject}`
      : '');
  const references = parent
    ? [...parent.references, parent.messageId]
    : command.inReplyTo
      ? [bareId(command.inReplyTo)]
      : [];
  const inReplyTo = references.at(-1) ?? null;
  const sent = from.address === box.address;
  const to = command.to?.length
    ? command.to.map(address)
    : [{ address: box.address, name: box.name }];
  const cc = (command.cc ?? []).map(address);
  const at = command.at ?? context.now;
  const domain = from.address.slice(from.address.indexOf('@') + 1);
  const id =
    messageId ??
    `sim.${at.toString(36)}.${await context.store.sequence('inbound')}@${domain}`;
  const threadId =
    parent && baseSubject(parent.subject) === baseSubject(subject)
      ? parent.threadId
      : await threadByReferences(context, references, subject);
  const message = await storeMessage(context, {
    headers: composeHeaders({
      from,
      to,
      cc,
      subject,
      messageId: id,
      inReplyTo,
      references,
      date: at,
      deliveredTo: sent ? undefined : box.address,
      authentication: sent ? 'none' : (command.authentication ?? 'pass'),
    }),
    messageId: id,
    inReplyTo,
    references,
    from,
    to,
    cc,
    bcc: [],
    subject,
    text: command.text,
    html: command.html ?? null,
    attachments: command.attachments ?? [],
    labelIds: [
      ...(sent ? ['SENT'] : ['INBOX', 'UNREAD']),
      ...(await labelIds(context, command.labels ?? [])),
    ],
    internalDate: at,
    threadId,
  });

  return {
    kind: 'message',
    id: message.id,
    threadId: message.threadId,
    messageId: message.messageId,
    created: true,
  };
}

/** Applies a mailbox command at the context's simulation time. */
export async function command(
  context: GmailContext,
  input: GmailCommand,
): Promise<GmailCommandResult> {
  if (input.kind === 'deliver') return deliver(context, input);
  if (input.kind === 'bounce') {
    const originalMessage = await original(context, input.message);
    const recipient = input.recipient.trim().toLowerCase();
    if (
      !originalMessage ||
      ![...originalMessage.to, ...originalMessage.cc].some(
        (a) => a.address === recipient,
      ) ||
      !/^5\.\d{1,3}\.\d{1,3}$/.test(input.status)
    )
      throw new GmailCommandError(
        'A bounce needs an original outgoing message, its recipient and permanent status',
      );
    const result = await deliver(context, {
      kind: 'deliver',
      from: { address: 'mailer-daemon@mail.example.invalid' },
      threadOf: originalMessage.id,
      text: `Delivery failed (${input.status})`,
      authentication: input.authentication,
      messageId: `bounce.${originalMessage.id}.${recipient.replace(/[^a-z0-9]/g, '')}@mail.example.invalid`,
    });
    if (result.kind === 'message') {
      const saved = await context.store.get<MessageRecord>(
        kinds.message,
        result.id,
      );
      if (saved)
        await context.store.put(
          kinds.message,
          result.id,
          {
            ...saved.data,
            deliveryFailure: {
              originalMessageId: originalMessage.messageId,
              recipient,
              status: input.status,
            },
          },
          { createdAt: saved.createdAt, updatedAt: context.now },
        );
    }

    return result;
  }
  const record: MailboxRecord = {
    address: input.address.trim().toLowerCase(),
    name: input.name.trim(),
  };
  await context.store.put(kinds.mailbox, 'me', record, {
    createdAt: context.now,
    updatedAt: context.now,
  });
  await labelIds(context, input.labels ?? []);

  return { kind: 'mailbox', ...record };
}
