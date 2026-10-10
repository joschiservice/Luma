import type { Pool, PoolClient } from 'pg';

import type { MailProvider } from '../application/mail.js';
import { builtInRoles, isBuiltInRole } from '../domain/roles.js';
import type { MembershipRow } from './access.js';
import { membershipFromRow, membershipSelect } from './access.js';
import { workspaceTransaction } from './settings.js';

interface Delivery {
  id: string;
  kind:
    | 'invitation'
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
}

const formatTime = (value: Date) =>
  `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * Builds a Luma support notice for an owner who is still an active owner. Views name the member
 * shown and when the view started and ends; requests carry the reason support gave.
 */
async function supportMail(
  tx: PoolClient,
  tenantId: string,
  message: Delivery,
  origin: string,
) {
  const owner = (
    await tx.query<{ email: string }>(
      "SELECT u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.role='owner' AND m.status='active' AND NOT EXISTS(SELECT FROM account_disablements d WHERE d.user_id=m.user_id)",
      [tenantId, message.user_id],
    )
  ).rows[0];
  if (!owner) return null;
  const activity = `${origin}/app/${tenantId}/activity`;
  if (message.kind === 'support_access_requested') {
    const request = (
      await tx.query<{ reason: string; duration_hours: number }>(
        "SELECT reason,duration_hours FROM workspace_support_access_requests WHERE tenant_id=$1 AND id=$2 AND status='pending' AND expires_at>now()",
        [tenantId, message.target_id],
      )
    ).rows[0];
    if (!request) return null;

    return {
      to: owner.email,
      subject: 'Luma support asks for read-only access',
      text: `Luma support asks for read-only access to your workspace for ${request.duration_hours / 24 === 1 ? '24 hours' : `${request.duration_hours / 24} days`}.\n\nTheir reason: ${request.reason}\n\nApprove or decline the request: ${origin}/app/${tenantId}/settings/support`,
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
  const member = view.name ?? 'a member';
  if (message.kind === 'support_view_started')
    return {
      to: owner.email,
      subject: 'Luma support started a read-only view of your workspace',
      text: `Luma support started a read-only view of your workspace as ${member} at ${formatTime(view.created_at)}. It ends by ${formatTime(view.expires_at)}. Support can’t change anything in this view.\n\nSee every page they viewed in Activity: ${activity}\n\nEnd support access at any time: ${origin}/app/${tenantId}/settings/support`,
    };

  return {
    to: owner.email,
    subject: 'Luma support used emergency access to your workspace',
    text: `Luma support viewed your workspace read-only as ${member} without prior approval, for a security or legal reason, from ${formatTime(view.created_at)} to ${formatTime(view.ended_at ?? view.expires_at)}. Support couldn’t change anything.\n\nSee every page they viewed in Activity: ${activity}`,
  };
}

/** Drains durable messages with membership checks, bounded retries and stable provider keys. */
export function createMailDelivery(
  pool: Pool,
  provider: MailProvider | undefined,
  origin: string,
  token: (tenantId: string, id: string, generation: number) => string,
) {
  let running: Promise<void> | undefined;

  async function drain() {
    if (!provider) return;
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
              message.attempts >= 5 ||
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
            let to: string | undefined;
            let subject = 'Your Luma test email';
            let text = `Email delivery is working. Manage your preferences: ${origin}/app/${tenantId}/settings/notifications`;
            if (message.kind === 'invitation') {
              const invite = (
                await tx.query<{
                  email: string;
                  role: string;
                  roleName: string | null;
                  inviterId: string;
                }>(
                  `SELECT i.email,i.role,r.name AS "roleName",i.inviter_id AS "inviterId" FROM workspace_invitations i
              LEFT JOIN workspace_roles r ON r.tenant_id=i.tenant_id AND r.id=i.custom_role_id AND r.archived_at IS NULL
              WHERE i.tenant_id=$1 AND i.id=$2 AND i.generation=$3 AND i.status='pending' AND i.expires_at>now()`,
                  [tenantId, message.invitation_id, message.generation],
                )
              ).rows[0];
              // The inviter must still be allowed to invite when the message is sent.
              const inviter = invite
                ? (
                    await tx.query<MembershipRow>(
                      `${membershipSelect} WHERE m.tenant_id=$1 AND m.user_id=$2`,
                      [tenantId, invite.inviterId],
                    )
                  ).rows[0]
                : undefined;
              const allowed =
                invite &&
                inviter &&
                (invite.role !== 'custom' || invite.roleName) &&
                inviter.status === 'active' &&
                !inviter.accountDisabled &&
                membershipFromRow(inviter).permissions.has('members.manage');
              const roleName =
                invite?.roleName ??
                (invite && isBuiltInRole(invite.role)
                  ? builtInRoles[invite.role].name
                  : 'Member');
              to = allowed ? invite.email : undefined;
              subject = 'You’re invited to a Luma workspace';
              text = `You have been invited with the ${roleName} role. Sign in with this email address to review and accept the invitation. This link expires in seven days.\n\n${origin}/app/invitations/${tenantId}/${message.invitation_id}#${token(tenantId, message.invitation_id!, message.generation!)}`;
            } else if (
              message.kind === 'support_view_started' ||
              message.kind === 'support_view_ended' ||
              message.kind === 'support_access_requested'
            ) {
              const mail = await supportMail(tx, tenantId, message, origin);
              to = mail?.to;
              subject = mail?.subject ?? subject;
              text = mail?.text ?? text;
            } else {
              const recipient = (
                await tx.query<{
                  email: string;
                  issues: boolean;
                  connections: boolean;
                }>(
                  `SELECT u.email,COALESCE(p.issues,false) AS issues,COALESCE(p.connections,false) AS connections FROM memberships m JOIN users u ON u.id=m.user_id
              LEFT JOIN notification_preferences p ON p.tenant_id=m.tenant_id AND p.user_id=m.user_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.status='active'
                AND NOT EXISTS(SELECT FROM account_disablements d WHERE d.user_id=m.user_id)`,
                  [tenantId, message.user_id],
                )
              ).rows[0];
              if (
                recipient &&
                (message.kind === 'test' || recipient[message.kind])
              )
                to = recipient.email;
              if (message.kind !== 'test') {
                subject =
                  message.kind === 'issues'
                    ? 'An issue needs your attention in Luma'
                    : 'A connection needs your attention in Luma';
                text = `${subject}.\n\n${origin}/app/${tenantId}/${message.kind === 'issues' ? `exceptions/${message.target_id}/detail` : `connections#connection-${message.target_id}`}\n\nManage email preferences: ${origin}/app/${tenantId}/settings/notifications`;
              }
            }
            if (!to) {
              await tx.query(
                "UPDATE workspace_mail SET state='cancelled' WHERE tenant_id=$1 AND id=$2",
                [tenantId, message.id],
              );

              return;
            }

            return { id: message.id, to, subject, text };
          },
        );
        if (!delivery) continue;
        let sent = false;
        try {
          // Eligibility is committed before dispatch; network I/O never holds operational locks.
          await provider.send(delivery);
          sent = true;
        } catch {
          // The durable attempt and provider key make uncertain responses safe to retry.
        }
        await workspaceTransaction(pool, tenantId, '', async (tx) => {
          await tx.query(
            `UPDATE workspace_mail SET
              state=CASE WHEN $4 THEN 'sent' WHEN attempts>=5 THEN 'failed' ELSE 'queued' END,
              sent_at=CASE WHEN $4 THEN now() ELSE sent_at END,
              next_attempt_at=now()+($5 * interval '1 second')
             WHERE tenant_id=$1 AND id=$2 AND state='queued' AND attempts=$3`,
            [
              tenantId,
              delivery.id,
              reserved.attempts,
              sent,
              30 * 2 ** reserved.attempts,
            ],
          );
        });
      }
    }
  }

  return {
    /** Runs one delivery pass; concurrent calls share the in-flight pass. */
    drain() {
      return (running ??= drain().finally(() => {
        running = undefined;
      }));
    },
  };
}
