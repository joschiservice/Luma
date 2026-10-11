import type { AppUiProps } from '@luma/app-host/web';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { useForm } from '@tanstack/react-form';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';

const accessSchema = z.object({
  emailAddress: z.string().nullable(),
  canRead: z.boolean().nullable(),
  canSend: z.boolean().nullable(),
});

const startInput = z.object({
  label: z.string().trim().min(1).max(120),
  loginHint: z.string().trim().toLowerCase().email().max(320).optional(),
});

/** Renders Gmail authorization for a new or existing mailbox, or token replacement without OAuth. */
export default function GmailSettings(props: AppUiProps) {
  // Without OAuth, such as in the simulator, a mailbox reconnects with a new access token.
  return props.connection?.management?.includes('rotate') &&
    props.connection.status !== 'disconnected' ? (
    <GmailToken {...props} />
  ) : (
    <GmailAuthorization {...props} />
  );
}

/** Explains how inbox rules limit what Luma reads, with a link to manage them. */
function RulesHelp({ organizationId }: { organizationId: string }) {
  return (
    <p className="field-help">
      {m.gmail_rules_help()}{' '}
      <a href={`/app/${encodeURIComponent(organizationId)}/inbox/settings`}>
        {m.gmail_rules_link()}
      </a>
    </p>
  );
}

/** Shows the mailbox and the Google access recorded for it, naming missing read or send access. */
function GmailAccess({
  services,
  connectionId,
}: {
  services: AppUiProps['services'];
  connectionId: string;
}) {
  const [access, setAccess] = useState<z.infer<typeof accessSchema> | null>(
    null,
  );
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setAccess(null);
    setError('');
    void services
      .request('access', { connectionId })
      .then((value) => {
        if (active) setAccess(accessSchema.parse(value));
      })
      .catch((reason: unknown) => {
        if (active) setError(services.error(reason));
      });

    return () => {
      active = false;
    };
  }, [services, connectionId]);
  if (error)
    return <p role="alert">{m.gmail_access_check_failed({ error })}</p>;
  if (!access) return <p role="status">{m.gmail_access_checking()}</p>;

  return (
    <div className="field-help">
      {access.emailAddress ? (
        <p>{m.gmail_access_mailbox({ address: access.emailAddress })}</p>
      ) : null}
      {access.canRead === null ? (
        <p role="status">{m.gmail_access_unknown()}</p>
      ) : (
        <>
          <p role={access.canRead ? undefined : 'status'}>
            {access.canRead
              ? m.gmail_access_read_granted()
              : m.gmail_access_read_missing()}
          </p>
          <p role={access.canSend ? undefined : 'status'}>
            {access.canSend
              ? m.gmail_access_send_granted()
              : m.gmail_access_send_missing()}
          </p>
        </>
      )}
    </div>
  );
}

/** Starts Google authorization; reconnecting preselects the connected mailbox. */
function GmailAuthorization({
  connection,
  services,
  organizationId,
}: AppUiProps) {
  const mailbox = connection?.target.emailAddress ?? '';
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const form = useForm({
    defaultValues: { label: connection?.label ?? '', mailbox },
    onSubmit: async ({ value }) => {
      if (lock.current) return;
      const input = startInput.safeParse({
        label: value.label,
        ...(value.mailbox.trim() ? { loginHint: value.mailbox } : {}),
      });
      if (!input.success) {
        setMessage(m.gmail_authorize_invalid());

        return;
      }
      lock.current = true;
      setPending(true);
      setMessage('');
      try {
        const result = z
          .object({ authorizationUrl: z.string().url() })
          .parse(await services.request('authorize', input.data));
        const url = new URL(result.authorizationUrl);
        if (
          url.origin !== 'https://accounts.google.com' ||
          url.pathname !== '/o/oauth2/v2/auth'
        )
          throw new Error('Invalid authorization URL');
        window.location.assign(url.href);
      } catch (error) {
        setMessage(services.error(error));
        setPending(false);
        lock.current = false;
      }
    },
  });

  return (
    <form
      className="connection-setup-form"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
      aria-busy={pending}
    >
      <p className="field-help">{m.gmail_authorize_help()}</p>
      {connection ? (
        <GmailAccess services={services} connectionId={connection.id} />
      ) : null}
      <RulesHelp organizationId={organizationId} />
      <form.Field name="label">
        {(field) => (
          <div className="form-field">
            <label htmlFor="gmail-label">
              {m.gmail_authorize_label_name()}
            </label>
            <Input
              id="gmail-label"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              onBlur={field.handleBlur}
              required
              maxLength={120}
              disabled={pending}
            />
          </div>
        )}
      </form.Field>
      <form.Field name="mailbox">
        {(field) => (
          <div className="form-field">
            <label htmlFor="gmail-mailbox">
              {m.gmail_authorize_label_mailbox()}
            </label>
            <Input
              id="gmail-mailbox"
              type="email"
              autoComplete="off"
              spellCheck={false}
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
              onBlur={field.handleBlur}
              maxLength={320}
              disabled={pending}
              placeholder={m.gmail_authorize_mailbox_placeholder()}
              aria-describedby="gmail-mailbox-help"
            />
            <p id="gmail-mailbox-help" className="field-help">
              {m.gmail_authorize_mailbox_help()}
            </p>
          </div>
        )}
      </form.Field>
      <p role="alert">{message}</p>
      <Button type="submit" disabled={pending}>
        {pending
          ? m.gmail_authorize_opening()
          : connection
            ? m.gmail_authorize_reconnect()
            : m.gmail_authorize_continue()}
      </Button>
    </form>
  );
}

/** Replaces a token-based mailbox's access token, which also reconnects a revoked mailbox. */
function GmailToken({
  connection,
  services,
  done,
  organizationId,
}: AppUiProps) {
  const [token, setToken] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  if (!connection) return null;

  return (
    <form
      className="connection-setup-form"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || !token.trim()) return;
        setPending(true);
        setMessage('');
        services
          .rotate(connection, { token: token.trim() })
          .then(done)
          .catch((error: unknown) => setMessage(services.error(error)))
          .finally(() => {
            setToken('');
            setPending(false);
          });
      }}
    >
      <p className="field-help">
        {m.gmail_token_help({
          address: connection.target.emailAddress ?? '',
        })}
      </p>
      <RulesHelp organizationId={organizationId} />
      <div className="form-field">
        <label htmlFor="gmail-token">{m.gmail_token_label()}</label>
        <Input
          id="gmail-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          required
          disabled={pending}
        />
      </div>
      <p role="alert">{message}</p>
      <Button type="submit" disabled={pending || !token.trim()}>
        {pending ? m.common_saving() : m.gmail_token_save()}
      </Button>
    </form>
  );
}
