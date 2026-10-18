import type { Locale } from '@luma/i18n/locales';
import { m } from '@luma/i18n/messages';
import type { ReactElement } from 'react';

import { formatEmailDate, formatEmailDateTime } from './format.js';
import {
  Action,
  EmailLayout,
  Facts,
  Paragraph,
  Quote,
  SecondaryLink,
} from './layout.js';

/** A built-in role, translated in the email, or the name of a workspace's custom role. */
type EmailRole = { builtIn: 'owner' | 'admin' | 'member' } | { custom: string };

/**
 * Every email Luma sends, with the facts it shows. Links are absolute. Times are shown in
 * `timeZone`, an IANA zone such as the workspace's. Values are shown as text and never parsed
 * as markup.
 */
export type Email =
  | {
      kind: 'invitation';
      workspace: string;
      inviter: string;
      role: EmailRole;
      expiresAt: Date;
      timeZone: string;
      link: string;
    }
  | {
      kind: 'morning_brief';
      workspace: string;
      timeZone: string;
      start: string;
      end: string;
      attention: number;
      active: number | null;
      verified: number | null;
      partial: boolean;
      decisions: { label: string; link: string }[];
      cases: { label: string; link: string; verified: boolean }[];
      link: string;
      preferencesLink: string;
    }
  | {
      kind: 'stock_protection';
      stage: 'placed' | 'partial_failure' | 'escalated' | 'released';
      store: string;
      workspace: string;
      link: string;
      preferencesLink: string;
    }
  | { kind: 'test'; workspace: string; preferencesLink: string }
  | {
      kind: 'issue' | 'connection';
      workspace: string;
      link: string;
      preferencesLink: string;
    }
  | {
      kind: 'support_access_requested';
      workspace: string;
      days: number;
      reason: string;
      link: string;
    }
  | {
      kind: 'support_inspection_requested';
      workspace: string;
      reason: string;
      link: string;
    }
  | {
      kind: 'support_inspection_emergency';
      workspace: string;
      category: 'security_incident' | 'legal_request';
      from: Date;
      until: Date;
      timeZone: string;
      activityLink: string;
    }
  | {
      kind: 'support_view_started';
      workspace: string;
      member: string | null;
      startedAt: Date;
      endsAt: Date;
      timeZone: string;
      activityLink: string;
      endLink: string;
    }
  | {
      kind: 'support_view_emergency';
      workspace: string;
      member: string | null;
      from: Date;
      until: Date;
      timeZone: string;
      activityLink: string;
    }
  | { kind: 'password_reset'; link: string }
  | { kind: 'password_changed'; resetLink: string }
  | { kind: 'email_verification'; link: string }
  | {
      kind: 'security_factor_added';
      factor: 'passkey' | 'authenticator';
      resetLink: string;
    }
  | { kind: 'account_deletion_scheduled'; eraseAfter: Date }
  | {
      kind: 'workspace_closure_scheduled' | 'workspace_closure_reminder';
      workspace: string;
      deletionAt: Date;
    }
  | { kind: 'account_restored'; signInLink: string }
  | { kind: 'account_erased' }
  | { kind: 'account_inspection_requested'; reason: string; link: string }
  | {
      kind: 'account_inspection_emergency';
      category: 'security_incident' | 'legal_request';
      from: Date;
      until: Date;
      link: string;
    };

/** Names why Luma support opened emergency access, in the recipient's language. */
function inspectionCategory(
  category: 'security_incident' | 'legal_request',
  o: { locale: Locale },
) {
  return category === 'security_incident'
    ? m.email_support_inspection_category_security_incident({}, o)
    : m.email_support_inspection_category_legal_request({}, o);
}

/** The subject line and the document of one email in the recipient's language. */
export function emailContent(
  email: Email,
  locale: Locale,
): { subject: string; document: ReactElement } {
  const o = { locale };
  switch (email.kind) {
    case 'morning_brief': {
      const values = { workspace: email.workspace };
      const number = (value: number | null) =>
        value === null
          ? m.email_morning_brief_unavailable({}, o)
          : new Intl.NumberFormat(locale).format(value);

      return {
        subject: m.email_morning_brief_subject(values, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_morning_brief_preview({}, o)}
            heading={m.email_morning_brief_subject(values, o)}
            reason={{
              kind: 'workspace',
              workspace: email.workspace,
              preferencesLink: email.preferencesLink,
            }}
          >
            <Paragraph>
              {m.email_morning_brief_window(
                {
                  start: formatEmailDateTime(
                    new Date(email.start),
                    locale,
                    email.timeZone,
                  ),
                  end: formatEmailDateTime(
                    new Date(email.end),
                    locale,
                    email.timeZone,
                  ),
                },
                o,
              )}
            </Paragraph>
            <Facts
              items={[
                {
                  label: m.email_morning_brief_attention({}, o),
                  value: number(email.attention),
                },
                {
                  label: m.email_morning_brief_active({}, o),
                  value: number(email.active),
                },
                {
                  label: m.email_morning_brief_verified({}, o),
                  value: number(email.verified),
                },
              ]}
            />
            <Paragraph>{m.email_morning_brief_honesty({}, o)}</Paragraph>
            {email.partial ? (
              <Paragraph>{m.email_morning_brief_partial({}, o)}</Paragraph>
            ) : null}
            {email.decisions.map((item) => (
              <SecondaryLink key={item.link} href={item.link}>
                {item.label}
              </SecondaryLink>
            ))}
            {email.cases.map((item) => (
              <SecondaryLink key={item.link} href={item.link}>
                {item.verified
                  ? m.email_morning_brief_case_verified(
                      { label: item.label },
                      o,
                    )
                  : m.email_morning_brief_case_ongoing(
                      { label: item.label },
                      o,
                    )}
              </SecondaryLink>
            ))}
            <Action locale={locale} href={email.link}>
              {m.email_morning_brief_open({}, o)}
            </Action>
          </EmailLayout>
        ),
      };
    }
    case 'invitation': {
      const role =
        'custom' in email.role
          ? email.role.custom
          : {
              owner: m.permissions_role_owner_name,
              admin: m.permissions_role_admin_name,
              member: m.permissions_role_member_name,
            }[email.role.builtIn]({}, o);
      const values = {
        workspace: email.workspace,
        inviter: email.inviter,
        role,
      };

      return {
        subject: m.email_invitation_subject(values, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_invitation_preview(values, o)}
            heading={m.email_invitation_heading(values, o)}
            reason={{ kind: 'invitation' }}
          >
            <Paragraph>{m.email_invitation_body(values, o)}</Paragraph>
            <Facts
              items={[
                {
                  label: m.email_invitation_workspace_label({}, o),
                  value: email.workspace,
                },
                { label: m.email_invitation_role_label({}, o), value: role },
                {
                  label: m.email_invitation_inviter_label({}, o),
                  value: email.inviter,
                },
                {
                  label: m.email_invitation_expires_label({}, o),
                  value: formatEmailDateTime(
                    email.expiresAt,
                    locale,
                    email.timeZone,
                  ),
                },
              ]}
            />
            <Paragraph>{m.email_invitation_instructions({}, o)}</Paragraph>
            <Action locale={locale} href={email.link}>
              {m.email_invitation_action({}, o)}
            </Action>
          </EmailLayout>
        ),
      };
    }
    case 'test':
      return {
        subject: m.email_test_subject({}, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_test_preview({}, o)}
            heading={m.email_test_heading({}, o)}
            reason={{
              kind: 'workspace',
              workspace: email.workspace,
              preferencesLink: email.preferencesLink,
            }}
          >
            <Paragraph>
              {m.email_test_body({ workspace: email.workspace }, o)}
            </Paragraph>
            <Action locale={locale} href={email.preferencesLink}>
              {m.email_test_action({}, o)}
            </Action>
          </EmailLayout>
        ),
      };
    case 'stock_protection': {
      const body = {
        placed: m.email_protection_placed,
        partial_failure: m.email_protection_partial,
        escalated: m.email_protection_escalated,
        released: m.email_protection_released,
      }[email.stage];

      return {
        subject: m.email_protection_subject({ store: email.store }, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_protection_preview({}, o)}
            heading={m.email_protection_heading({}, o)}
            reason={{
              kind: 'workspace',
              workspace: email.workspace,
              preferencesLink: email.preferencesLink,
            }}
          >
            <Paragraph>{body({ store: email.store }, o)}</Paragraph>
            <Action locale={locale} href={email.link}>
              {m.email_protection_action({}, o)}
            </Action>
          </EmailLayout>
        ),
      };
    }
    case 'issue':
    case 'connection': {
      const text =
        email.kind === 'issue'
          ? {
              subject: m.email_issue_subject,
              preview: m.email_issue_preview,
              heading: m.email_issue_heading,
              body: m.email_issue_body,
              action: m.email_issue_action,
            }
          : {
              subject: m.email_connection_subject,
              preview: m.email_connection_preview,
              heading: m.email_connection_heading,
              body: m.email_connection_body,
              action: m.email_connection_action,
            };
      const values = { workspace: email.workspace };

      return {
        subject: text.subject(values, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={text.preview({}, o)}
            heading={text.heading({}, o)}
            reason={{
              kind: 'workspace',
              workspace: email.workspace,
              preferencesLink: email.preferencesLink,
            }}
          >
            <Paragraph>{text.body(values, o)}</Paragraph>
            <Action locale={locale} href={email.link}>
              {text.action({}, o)}
            </Action>
          </EmailLayout>
        ),
      };
    }
    case 'support_access_requested': {
      const values = {
        workspace: email.workspace,
        duration: m.email_support_request_duration({ days: email.days }, o),
      };

      return {
        subject: m.email_support_request_subject(values, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_support_request_preview(values, o)}
            heading={m.email_support_request_heading({}, o)}
            reason={{ kind: 'workspace', workspace: email.workspace }}
          >
            <Paragraph>{m.email_support_request_body(values, o)}</Paragraph>
            <Quote label={m.email_support_request_reason({}, o)}>
              {email.reason}
            </Quote>
            <Action locale={locale} href={email.link}>
              {m.email_support_request_action({}, o)}
            </Action>
          </EmailLayout>
        ),
      };
    }
    case 'support_inspection_requested': {
      const values = { workspace: email.workspace };

      return {
        subject: m.email_support_inspection_subject(values, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_support_inspection_preview(values, o)}
            heading={m.email_support_inspection_heading({}, o)}
            reason={{ kind: 'workspace', workspace: email.workspace }}
          >
            <Paragraph>{m.email_support_inspection_body(values, o)}</Paragraph>
            <Quote label={m.email_support_request_reason({}, o)}>
              {email.reason}
            </Quote>
            <Paragraph>{m.email_support_inspection_limits({}, o)}</Paragraph>
            <Action locale={locale} href={email.link}>
              {m.email_support_request_action({}, o)}
            </Action>
          </EmailLayout>
        ),
      };
    }
    case 'support_inspection_emergency': {
      const values = {
        workspace: email.workspace,
        category: inspectionCategory(email.category, o),
      };

      return {
        subject: m.email_support_inspection_emergency_subject(values, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_support_inspection_emergency_preview(values, o)}
            heading={m.email_support_inspection_emergency_heading({}, o)}
            reason={{ kind: 'workspace', workspace: email.workspace }}
          >
            <Paragraph>
              {m.email_support_inspection_emergency_body(values, o)}
            </Paragraph>
            <Facts
              items={[
                {
                  label: m.email_support_emergency_from_label({}, o),
                  value: formatEmailDateTime(
                    email.from,
                    locale,
                    email.timeZone,
                  ),
                },
                {
                  label: m.email_support_emergency_until_label({}, o),
                  value: formatEmailDateTime(
                    email.until,
                    locale,
                    email.timeZone,
                  ),
                },
              ]}
            />
            <Action locale={locale} href={email.activityLink}>
              {m.email_support_emergency_action({}, o)}
            </Action>
          </EmailLayout>
        ),
      };
    }
    case 'support_view_started': {
      const end = formatEmailDateTime(email.endsAt, locale, email.timeZone);
      const values = {
        workspace: email.workspace,
        member: email.member ?? m.email_support_member_unknown({}, o),
        end,
      };

      return {
        subject: m.email_support_view_subject(values, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_support_view_preview(values, o)}
            heading={m.email_support_view_heading({}, o)}
            reason={{ kind: 'workspace', workspace: email.workspace }}
          >
            <Paragraph>{m.email_support_view_body(values, o)}</Paragraph>
            <Facts
              items={[
                {
                  label: m.email_support_view_started_label({}, o),
                  value: formatEmailDateTime(
                    email.startedAt,
                    locale,
                    email.timeZone,
                  ),
                },
                { label: m.email_support_view_ends_label({}, o), value: end },
              ]}
            />
            <Action locale={locale} href={email.activityLink}>
              {m.email_support_view_action({}, o)}
            </Action>
            <SecondaryLink href={email.endLink}>
              {m.email_support_view_end({}, o)}
            </SecondaryLink>
          </EmailLayout>
        ),
      };
    }
    case 'support_view_emergency': {
      const values = {
        workspace: email.workspace,
        member: email.member ?? m.email_support_member_unknown({}, o),
      };

      return {
        subject: m.email_support_emergency_subject(values, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_support_emergency_preview({}, o)}
            heading={m.email_support_emergency_heading({}, o)}
            reason={{ kind: 'workspace', workspace: email.workspace }}
          >
            <Paragraph>{m.email_support_emergency_body(values, o)}</Paragraph>
            <Facts
              items={[
                {
                  label: m.email_support_emergency_from_label({}, o),
                  value: formatEmailDateTime(
                    email.from,
                    locale,
                    email.timeZone,
                  ),
                },
                {
                  label: m.email_support_emergency_until_label({}, o),
                  value: formatEmailDateTime(
                    email.until,
                    locale,
                    email.timeZone,
                  ),
                },
              ]}
            />
            <Action locale={locale} href={email.activityLink}>
              {m.email_support_emergency_action({}, o)}
            </Action>
          </EmailLayout>
        ),
      };
    }
    case 'password_reset':
      return {
        subject: m.email_password_reset_subject({}, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_password_reset_preview({}, o)}
            heading={m.email_password_reset_heading({}, o)}
            reason={{ kind: 'account' }}
          >
            <Paragraph>{m.email_password_reset_body({}, o)}</Paragraph>
            <Action locale={locale} href={email.link}>
              {m.email_password_reset_action({}, o)}
            </Action>
            <Paragraph tone="muted">
              {m.email_password_reset_ignore({}, o)}
            </Paragraph>
          </EmailLayout>
        ),
      };
    case 'password_changed':
      return {
        subject: m.email_password_changed_subject({}, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_password_changed_preview({}, o)}
            heading={m.email_password_changed_heading({}, o)}
            reason={{ kind: 'account' }}
          >
            <Paragraph>{m.email_password_changed_body({}, o)}</Paragraph>
            <Paragraph>{m.email_password_changed_warning({}, o)}</Paragraph>
            <Action locale={locale} href={email.resetLink}>
              {m.email_password_changed_action({}, o)}
            </Action>
          </EmailLayout>
        ),
      };
    case 'email_verification':
      return {
        subject: m.email_verification_subject({}, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_verification_preview({}, o)}
            heading={m.email_verification_heading({}, o)}
            reason={{ kind: 'account' }}
          >
            <Paragraph>{m.email_verification_body({}, o)}</Paragraph>
            <Action locale={locale} href={email.link}>
              {m.email_verification_action({}, o)}
            </Action>
            <Paragraph tone="muted">
              {m.email_verification_ignore({}, o)}
            </Paragraph>
          </EmailLayout>
        ),
      };
    case 'security_factor_added': {
      const passkey = email.factor === 'passkey';

      return {
        subject: passkey
          ? m.email_factor_passkey_subject({}, o)
          : m.email_factor_authenticator_subject({}, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_factor_preview({}, o)}
            heading={
              passkey
                ? m.email_factor_passkey_subject({}, o)
                : m.email_factor_authenticator_subject({}, o)
            }
            reason={{ kind: 'account' }}
          >
            <Paragraph>
              {passkey
                ? m.email_factor_passkey_body({}, o)
                : m.email_factor_authenticator_body({}, o)}
            </Paragraph>
            <Paragraph>{m.email_factor_warning({}, o)}</Paragraph>
            <Action locale={locale} href={email.resetLink}>
              {m.email_password_changed_action({}, o)}
            </Action>
          </EmailLayout>
        ),
      };
    }
    case 'account_deletion_scheduled': {
      const date = formatEmailDate(email.eraseAfter, locale, 'UTC');

      return {
        subject: m.email_account_scheduled_subject({}, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_account_scheduled_preview({ date }, o)}
            heading={m.email_account_scheduled_heading({}, o)}
            reason={{ kind: 'account' }}
          >
            <Paragraph>{m.email_account_scheduled_body({}, o)}</Paragraph>
            <Paragraph>
              {m.email_account_scheduled_erase({ date }, o)}
            </Paragraph>
            <Paragraph>{m.email_account_scheduled_keep({}, o)}</Paragraph>
          </EmailLayout>
        ),
      };
    }
    case 'workspace_closure_scheduled':
    case 'workspace_closure_reminder': {
      const values = {
        workspace: email.workspace,
        date: formatEmailDate(email.deletionAt, locale, 'UTC'),
      };
      const reminder = email.kind === 'workspace_closure_reminder';

      return {
        subject: reminder
          ? m.email_workspace_closure_reminder_subject(values, o)
          : m.email_workspace_closure_scheduled_subject(values, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_workspace_closure_preview(values, o)}
            heading={
              reminder
                ? m.email_workspace_closure_reminder_subject(values, o)
                : m.email_workspace_closure_scheduled_subject(values, o)
            }
            reason={{ kind: 'workspace', workspace: email.workspace }}
          >
            <Paragraph>
              {reminder
                ? m.email_workspace_closure_reminder_body(values, o)
                : m.email_workspace_closure_scheduled_body(values, o)}
            </Paragraph>
            <Paragraph>{m.email_workspace_closure_scope({}, o)}</Paragraph>
            <Paragraph>{m.email_workspace_closure_keep(values, o)}</Paragraph>
          </EmailLayout>
        ),
      };
    }
    case 'account_restored':
      return {
        subject: m.email_account_restored_subject({}, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_account_restored_preview({}, o)}
            heading={m.email_account_restored_heading({}, o)}
            reason={{ kind: 'account' }}
          >
            <Paragraph>{m.email_account_restored_body({}, o)}</Paragraph>
            <Action locale={locale} href={email.signInLink}>
              {m.email_account_restored_action({}, o)}
            </Action>
          </EmailLayout>
        ),
      };
    case 'account_erased':
      return {
        subject: m.email_account_erased_subject({}, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_account_erased_preview({}, o)}
            heading={m.email_account_erased_heading({}, o)}
            reason={{ kind: 'account' }}
          >
            <Paragraph>{m.email_account_erased_body({}, o)}</Paragraph>
            <Paragraph>{m.email_account_erased_records({}, o)}</Paragraph>
          </EmailLayout>
        ),
      };
    case 'account_inspection_requested':
      return {
        subject: m.email_account_inspection_subject({}, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_account_inspection_preview({}, o)}
            heading={m.email_account_inspection_heading({}, o)}
            reason={{ kind: 'account' }}
          >
            <Paragraph>{m.email_account_inspection_body({}, o)}</Paragraph>
            <Quote label={m.email_support_request_reason({}, o)}>
              {email.reason}
            </Quote>
            <Paragraph>{m.email_account_inspection_limits({}, o)}</Paragraph>
            <Action locale={locale} href={email.link}>
              {m.email_support_request_action({}, o)}
            </Action>
          </EmailLayout>
        ),
      };
    case 'account_inspection_emergency': {
      const values = { category: inspectionCategory(email.category, o) };

      return {
        subject: m.email_account_inspection_emergency_subject({}, o),
        document: (
          <EmailLayout
            locale={locale}
            preview={m.email_account_inspection_emergency_preview(values, o)}
            heading={m.email_account_inspection_emergency_heading({}, o)}
            reason={{ kind: 'account' }}
          >
            <Paragraph>
              {m.email_account_inspection_emergency_body(values, o)}
            </Paragraph>
            <Facts
              items={[
                {
                  label: m.email_support_emergency_from_label({}, o),
                  value: formatEmailDateTime(email.from, locale, 'UTC'),
                },
                {
                  label: m.email_support_emergency_until_label({}, o),
                  value: formatEmailDateTime(email.until, locale, 'UTC'),
                },
              ]}
            />
            <Action locale={locale} href={email.link}>
              {m.email_account_inspection_emergency_action({}, o)}
            </Action>
          </EmailLayout>
        ),
      };
    }
  }
}
