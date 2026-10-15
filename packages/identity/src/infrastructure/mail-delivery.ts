import type { Email } from '@luma/email';
import type { Locale } from '@luma/i18n/locales';
import type { Pool, PoolClient } from 'pg';

import type { MailProvider } from '../application/mail.js';
import type { MorningBriefContent } from '../application/morning-brief.js';
import { morningBriefClock } from '../application/morning-brief.js';
import { isBuiltInRole } from '../domain/roles.js';
import type { MembershipRow } from './access.js';
import { membershipFromRow, membershipSelect } from './access.js';
import { drainAccountMail } from './account-deletion.js';
import {
  dispatchMail,
  maxAttempts,
  retryDelaySeconds,
} from './mail-dispatch.js';
import { briefAuthority } from './morning-brief.js';
import { drainPasswordMail } from './password-mail.js';
import { workspaceTransaction } from './settings.js';

interface Delivery {
  stock_protection_document?: {
    stage: 'placed' | 'partial_failure' | 'escalated' | 'released';
    store: string;
  } | null;
  id: string;
  kind:
    | 'invitation'
    | 'morning_brief'
    | 'test'
    | 'issues'
    | 'connections'
    | 'support_view_started'
    | 'support_view_ended'
    | 'support_access_requested';
  user_id: string | null;
  invitation_id: string | null;
  generation: number | null;
  target_id: string | null;
  attempts: number;
  first_attempt_at: Date | null;
  brief_document: {
    content: MorningBriefContent;
    authority: string;
    day: string;
  } | null;
}

interface Workspace {
  name: string;
  timeZone: string;
}

/** A message that passed its checks: the address, language and content to send. */
interface Addressed {
  to: string;
  locale: Locale;
  email: Email;
}

const language = (value: string | null | undefined): Locale =>
  value === 'de' ? 'de' : 'en';

/**
 * Builds a Luma support notice for an owner who is still an active owner, in the owner's
 * language. Views name the member shown and when the view started and ends; requests carry the
 * reason support gave.
 */
async function supportMail(
  tx: PoolClient,
  tenantId: string,
  message: Delivery,
  origin: string,
  workspace: Workspace,
): Promise<Addressed | null> {
  const owner = (
    await tx.query<{ email: string; locale: string | null }>(
      "SELECT u.email,u.locale FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.role='owner' AND m.status='active' AND NOT EXISTS(SELECT FROM account_disablements d WHERE d.user_id=m.user_id)",
      [tenantId, message.user_id],
    )
  ).rows[0];
  if (!owner) return null;
  const recipient = { to: owner.email, locale: language(owner.locale) };
  const activityLink = `${origin}/app/${tenantId}/activity`;
  const supportLink = `${origin}/app/${tenantId}/settings/support`;
  if (message.kind === 'support_access_requested') {
    const request = (
      await tx.query<{ reason: string; duration_hours: number }>(
        "SELECT reason,duration_hours FROM workspace_support_access_requests WHERE tenant_id=$1 AND id=$2 AND status='pending' AND expires_at>now()",
        [tenantId, message.target_id],
      )
    ).rows[0];
    if (!request) return null;

    return {
      ...recipient,
      email: {
        kind: 'support_access_requested',
        workspace: workspace.name,
        days: request.duration_hours / 24,
        reason: request.reason,
        link: supportLink,
      },
    };
  }
  const view = (
    await tx.query<{
      name: string | null;
      mode: 'consent' | 'emergency';
      created_at: Date;
      expires_at: Date;
      ended_at: Date | null;
    }>(
      `SELECT p.name,v.mode,v.created_at,v.expires_at,v.ended_at FROM support_view_sessions v
      LEFT JOIN workspace_people p ON p.tenant_id=v.tenant_id AND p.user_id=v.user_id WHERE v.tenant_id=$1 AND v.id=$2`,
      [tenantId, message.target_id],
    )
  ).rows[0];
  if (!view) return null;
  if (message.kind === 'support_view_started')
    return {
      ...recipient,
      email: {
        kind: 'support_view_started',
        workspace: workspace.name,
        member: view.name,
        startedAt: view.created_at,
        endsAt: view.expires_at,
        timeZone: workspace.timeZone,
        activityLink,
        endLink: supportLink,
      },
    };

  return {
    ...recipient,
    email: {
      kind: 'support_view_emergency',
      workspace: workspace.name,
      member: view.name,
      from: view.created_at,
      until: view.ended_at ?? view.expires_at,
      timeZone: workspace.timeZone,
      activityLink,
    },
  };
}

/**
 * Builds an invitation in the invitee's language when they already have an account, otherwise
 * the inviter's. The inviter must still be allowed to invite when the message is sent.
 */
async function invitationMail(
  tx: PoolClient,
  tenantId: string,
  message: Delivery,
  origin: string,
  workspace: Workspace,
  token: (tenantId: string, id: string, generation: number) => string,
): Promise<Addressed | null> {
  const invite = (
    await tx.query<{
      email: string;
      role: string;
      roleName: string | null;
      inviterId: string;
      expiresAt: Date;
    }>(
      `SELECT i.email,i.role,r.name AS "roleName",i.inviter_id AS "inviterId",i.expires_at AS "expiresAt" FROM workspace_invitations i
      LEFT JOIN workspace_roles r ON r.tenant_id=i.tenant_id AND r.id=i.custom_role_id AND r.archived_at IS NULL
      WHERE i.tenant_id=$1 AND i.id=$2 AND i.generation=$3 AND i.status='pending' AND i.expires_at>now()`,
      [tenantId, message.invitation_id, message.generation],
    )
  ).rows[0];
  if (!invite || (invite.role === 'custom' && !invite.roleName)) return null;
  const inviter = (
    await tx.query<MembershipRow>(
      `${membershipSelect} WHERE m.tenant_id=$1 AND m.user_id=$2`,
      [tenantId, invite.inviterId],
    )
  ).rows[0];
  if (
    !inviter ||
    inviter.status !== 'active' ||
    inviter.accountDisabled ||
    !membershipFromRow(inviter).permissions.has('members.manage')
  )
    return null;
  const people = await tx.query<{
    inviter: boolean;
    name: string;
    locale: string | null;
  }>(
    'SELECT id=$1 AS inviter,name,locale FROM users WHERE id=$1 OR lower(email)=lower($2)',
    [invite.inviterId, invite.email],
  );
  const inviterAccount = people.rows.find((row) => row.inviter);
  const invitee = people.rows.find((row) => !row.inviter);

  return {
    to: invite.email,
    locale: language(invitee?.locale ?? inviterAccount?.locale),
    email: {
      kind: 'invitation',
      workspace: workspace.name,
      inviter: inviterAccount?.name ?? workspace.name,
      role: invite.roleName
        ? { custom: invite.roleName }
        : { builtIn: isBuiltInRole(invite.role) ? invite.role : 'member' },
      expiresAt: invite.expiresAt,
      timeZone: workspace.timeZone,
      link: `${origin}/app/invitations/${tenantId}/${message.invitation_id}#${token(tenantId, message.invitation_id!, message.generation!)}`,
    },
  };
}

/**
 * Builds a test message or an opted-in notification for an active member. Notifications skip
 * members whose address bounced or reported spam; a test message is still sent, so a delivered
 * test resumes them.
 */
async function memberMail(
  tx: PoolClient,
  tenantId: string,
  message: Delivery,
  origin: string,
  workspace: Workspace,
): Promise<Addressed | null> {
  const recipient = (
    await tx.query<{
      email: string;
      locale: string | null;
      issues: boolean;
      connections: boolean;
      morning_brief: boolean;
      suppressed: boolean;
    }>(
      `SELECT u.email,u.locale,COALESCE(p.issues,false) AS issues,COALESCE(p.connections,false) AS connections,COALESCE(p.morning_brief,false) AS morning_brief,
        EXISTS(SELECT FROM mail_suppressions s WHERE s.user_id=u.id AND lower(s.email)=lower(u.email)) AS suppressed
      FROM memberships m JOIN users u ON u.id=m.user_id
      LEFT JOIN notification_preferences p ON p.tenant_id=m.tenant_id AND p.user_id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active'
        AND NOT EXISTS(SELECT FROM account_disablements d WHERE d.user_id=m.user_id)`,
      [tenantId, message.user_id],
    )
  ).rows[0];
  if (!recipient) return null;
  const preferencesLink = `${origin}/app/${tenantId}/settings/notifications`;
  const address = { to: recipient.email, locale: language(recipient.locale) };
  if (message.kind === 'test')
    return {
      ...address,
      email: { kind: 'test', workspace: workspace.name, preferencesLink },
    };
  if (message.kind === 'morning_brief') {
    if (
      !recipient.morning_brief ||
      recipient.suppressed ||
      !message.brief_document ||
      morningBriefClock(new Date(), workspace.timeZone).day !==
        message.brief_document.day
    )
      return null;
    const member = (
      await tx.query<MembershipRow>(
        `${membershipSelect} WHERE m.tenant_id=$1 AND m.user_id=$2`,
        [tenantId, message.user_id],
      )
    ).rows[0];
    if (!member || briefAuthority(member) !== message.brief_document.authority)
      return null;

    return {
      ...address,
      email: {
        ...message.brief_document.content,
        kind: 'morning_brief',
        workspace: workspace.name,
        timeZone: workspace.timeZone,
        link: `${origin}/app/${tenantId}/home?start=${encodeURIComponent(message.brief_document.content.start)}&end=${encodeURIComponent(message.brief_document.content.end)}`,
        preferencesLink,
      },
    };
  }
  if (
    (message.kind !== 'issues' && message.kind !== 'connections') ||
    !recipient[message.kind] ||
    recipient.suppressed
  )
    return null;

  return {
    ...address,
    email: {
      ...(message.stock_protection_document && message.kind === 'issues'
        ? {
            kind: 'stock_protection' as const,
            stage: message.stock_protection_document.stage,
            store: message.stock_protection_document.store,
          }
        : {
            kind:
              message.kind === 'issues'
                ? ('issue' as const)
                : ('connection' as const),
          }),
      workspace: workspace.name,
      link: `${origin}/app/${tenantId}/${message.kind === 'issues' ? `exceptions/${message.target_id}/detail` : `connections#connection-${message.target_id}`}`,
      preferencesLink,
    },
  };
}

/** Drains durable messages with membership checks, bounded retries and stable provider keys. */
export function createMailDelivery(
  pool: Pool,
  provider: MailProvider | undefined,
  origin: string,
  secret: string,
  token: (tenantId: string, id: string, generation: number) => string,
  morningBriefEnabled: (tenantId: string) => Promise<boolean> = async () =>
    false,
) {
  let running: Promise<void> | undefined;

  async function drain() {
    if (!provider) return;
    await pool.query(
      "DELETE FROM mail_receipts WHERE created_at<now()-interval '30 days'",
    );
    if (!(await drainPasswordMail(pool, provider, origin, secret))) return;
    if (!(await drainAccountMail(pool, provider, origin))) return;
    const tenants = await pool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM workspace_mail_tenants()',
    );
    for (const { tenant_id: tenantId } of tenants.rows) {
      for (let count = 0; count < 10; count++) {
        // Commit the attempt clock before calling the provider so a crash cannot reset its deduplication window.
        const reserved = await workspaceTransaction(
          pool,
          tenantId,
          '',
          async (tx) => {
            const message = (
              await tx.query<Delivery>(
                "SELECT * FROM workspace_mail WHERE tenant_id=$1 AND state='queued' AND next_attempt_at<=now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
                [tenantId],
              )
            ).rows[0];
            if (!message) return null;
            if (
              message.attempts >= maxAttempts ||
              (message.first_attempt_at &&
                Date.now() - message.first_attempt_at.getTime() >= 23 * 3600000)
            ) {
              await tx.query(
                "UPDATE workspace_mail SET state='failed' WHERE tenant_id=$1 AND id=$2",
                [tenantId, message.id],
              );

              return { ...message, attempts: -1 };
            }
            await tx.query(
              "UPDATE workspace_mail SET first_attempt_at=COALESCE(first_attempt_at,now()),attempts=attempts+1,next_attempt_at=now()+interval '60 seconds' WHERE tenant_id=$1 AND id=$2",
              [tenantId, message.id],
            );

            return { ...message, attempts: message.attempts + 1 };
          },
        );
        if (!reserved) break;
        if (reserved.attempts === -1) continue;
        const briefEnabled =
          reserved.kind !== 'morning_brief' ||
          (await morningBriefEnabled(tenantId));
        const delivery = await workspaceTransaction(
          pool,
          tenantId,
          '',
          async (tx) => {
            const message = (
              await tx.query<Delivery>(
                "SELECT * FROM workspace_mail WHERE tenant_id=$1 AND id=$2 AND state='queued' AND attempts=$3 FOR UPDATE",
                [tenantId, reserved.id, reserved.attempts],
              )
            ).rows[0];
            if (!message) return;
            if (
              message.first_attempt_at &&
              Date.now() - message.first_attempt_at.getTime() >= 23 * 3600000
            ) {
              await tx.query(
                "UPDATE workspace_mail SET state='failed' WHERE tenant_id=$1 AND id=$2",
                [tenantId, message.id],
              );

              return;
            }
            const workspace = (
              await tx.query<Workspace>(
                `SELECT o.name,COALESCE(s.timezone,'UTC') AS "timeZone" FROM organizations o
                LEFT JOIN workspace_settings s ON s.tenant_id=o.id WHERE o.id=$1`,
                [tenantId],
              )
            ).rows[0]!;
            const addressed = !briefEnabled
              ? null
              : message.kind === 'invitation'
                ? await invitationMail(
                    tx,
                    tenantId,
                    message,
                    origin,
                    workspace,
                    token,
                  )
                : message.kind === 'support_view_started' ||
                    message.kind === 'support_view_ended' ||
                    message.kind === 'support_access_requested'
                  ? await supportMail(tx, tenantId, message, origin, workspace)
                  : await memberMail(tx, tenantId, message, origin, workspace);
            if (!addressed) {
              await tx.query(
                "UPDATE workspace_mail SET state='cancelled' WHERE tenant_id=$1 AND id=$2",
                [tenantId, message.id],
              );

              return;
            }

            return { id: message.id, ...addressed };
          },
        );
        if (!delivery) continue;
        // Eligibility is committed before dispatch; network I/O never holds operational locks.
        const outcome = await dispatchMail(pool, provider, delivery);
        await workspaceTransaction(pool, tenantId, '', async (tx) => {
          await tx.query(
            outcome.status === 'deferred'
              ? // A rate-limited request was never processed, so it doesn't use up an attempt.
                `UPDATE workspace_mail SET attempts=attempts-1,next_attempt_at=now()+($4 * interval '1 second')
                 WHERE tenant_id=$1 AND id=$2 AND state='queued' AND attempts=$3`
              : `UPDATE workspace_mail SET
                  state=CASE WHEN $4 THEN 'sent' WHEN attempts>=${maxAttempts} THEN 'failed' ELSE 'queued' END,
                  sent_at=CASE WHEN $4 THEN now() ELSE sent_at END,
                  next_attempt_at=now()+($5 * interval '1 second')
                 WHERE tenant_id=$1 AND id=$2 AND state='queued' AND attempts=$3`,
            outcome.status === 'deferred'
              ? [tenantId, delivery.id, reserved.attempts, outcome.seconds]
              : [
                  tenantId,
                  delivery.id,
                  reserved.attempts,
                  outcome.status === 'sent',
                  retryDelaySeconds(reserved.attempts),
                ],
          );
        });
        if (outcome.status === 'deferred') return;
      }
    }
  }

  return {
    /**
     * Runs one delivery pass over password, account and workspace mail, in that order. A pass
     * stops when the provider's rate limit is reached. Concurrent calls share the in-flight pass.
     */
    drain() {
      return (running ??= drain().finally(() => {
        running = undefined;
      }));
    },
  };
}
