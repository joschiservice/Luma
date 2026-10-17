import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Input } from '@luma/ui/components/primitives/input';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Smartphone } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { encode } from 'uqr';

import {
  ApiError,
  auth,
  sessionKey,
  sessionOptions,
  usePasskeySupport,
} from '../../kit/identity/data';
import { privateQueryDefaults } from '../../lib/private-query';
import { PasswordSettings } from './password';
import { SectionHeading } from './section-heading';
import { SecurityActivity, securityActivityKey } from './security-activity';
import { SessionSettings } from './sessions';

const passkeysKey = ['private', 'passkeys'] as const;

/** Lists the signed-in person's passkeys; rejects failed reads with their HTTP status. */
const passkeysOptions = () =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: passkeysKey,
    queryFn: async ({ signal }) => {
      const result = await auth.passkey.listUserPasskeys({
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.error) throw new ApiError(result.error.status, result.error);

      return result.data.map((passkey) => ({
        id: passkey.id,
        name: passkey.name?.trim() || m.settings_security_passkey_fallback(),
        createdAt: passkey.createdAt
          ? new Date(passkey.createdAt).toISOString()
          : undefined,
        synced: passkey.deviceType === 'multiDevice',
      }));
    },
  });

type FactorFlow = 'enable' | 'regenerate' | 'disable';

/** Lets the signed-in person manage authenticator-app codes and passkeys for their account. */
export function SecuritySettings({ disabled }: { disabled: boolean }) {
  const session = useQuery(sessionOptions());
  const enabled = session.data?.user.twoFactorEnabled ?? false;
  const [flow, setFlow] = useState<FactorFlow | null>(null);
  const [notice, setNotice] = useState('');

  return (
    <section>
      <SectionHeading
        title={m.settings_security_title()}
        description={m.settings_security_description()}
        badge={m.settings_security_badge()}
      />
      <PasswordSettings disabled={disabled} />
      <div className="settings-panel">
        <div className="settings-panel-heading">
          <div>
            <h3>{m.settings_security_totp_title()}</h3>
            <p>{m.settings_security_totp_description()}</p>
          </div>
          {session.data ? (
            <Badge tone={enabled ? 'success' : 'neutral'}>
              {enabled ? m.settings_security_on() : m.settings_security_off()}
            </Badge>
          ) : null}
        </div>
        <div className="settings-preference">
          <span>
            <strong>
              {enabled
                ? m.settings_security_totp_enabled()
                : m.settings_security_totp_not_set_up()}
            </strong>
            <span>
              {enabled
                ? m.settings_security_totp_enabled_help()
                : m.settings_security_totp_disabled_help()}
            </span>
          </span>
          <div className="settings-security-actions">
            {enabled ? (
              <>
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() => setFlow('regenerate')}
                >
                  {m.settings_security_new_codes()}
                </Button>
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() => setFlow('disable')}
                >
                  {m.settings_security_turn_off()}
                </Button>
              </>
            ) : (
              <Button
                disabled={disabled || !session.data}
                onClick={() => setFlow('enable')}
              >
                {m.settings_security_set_up()}
              </Button>
            )}
          </div>
        </div>
        <p className="settings-note settings-security-notice" role="status">
          {notice}
        </p>
      </div>
      <PasskeySettings disabled={disabled} />
      <SessionSettings disabled={disabled} />
      <SecurityActivity />
      {flow ? (
        <FactorDialog
          flow={flow}
          onClose={(message) => {
            setFlow(null);
            if (message) setNotice(message);
          }}
        />
      ) : null}
    </section>
  );
}

function PasskeySettings({ disabled }: { disabled: boolean }) {
  const client = useQueryClient();
  const passkeys = useQuery(passkeysOptions());
  const supported = usePasskeySupport();
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{
    tone: 'danger' | 'success';
    text: string;
  } | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(
    null,
  );
  const nameId = useId();

  async function add() {
    if (pending) return;
    setPending(true);
    setMessage(null);
    try {
      const trimmed = name.trim();
      const result = await auth.passkey.addPasskey(
        trimmed ? { name: trimmed } : {},
      );
      if (result.error) {
        const code = 'code' in result.error ? result.error.code : undefined;
        setMessage({
          tone: 'danger',
          text:
            code === 'SESSION_NOT_FRESH'
              ? m.settings_security_passkey_not_fresh()
              : code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED'
                ? m.settings_security_passkey_duplicate()
                : result.error.status >= 500
                  ? m.settings_security_passkey_save_failed()
                  : m.settings_security_passkey_canceled(),
        });

        return;
      }
      setName('');
      setMessage({
        tone: 'success',
        text: m.settings_security_passkey_added(),
      });
    } catch {
      setMessage({
        tone: 'danger',
        text: m.settings_security_unreachable(),
      });
    } finally {
      setPending(false);
      await client.invalidateQueries({ queryKey: passkeysKey });
      await client.invalidateQueries({ queryKey: securityActivityKey });
    }
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel-heading">
        <div>
          <h3>{m.settings_security_passkeys_title()}</h3>
          <p>{m.settings_security_passkeys_description()}</p>
        </div>
        {passkeys.data ? (
          <Badge tone={passkeys.data.length ? 'success' : 'neutral'}>
            {passkeys.data.length
              ? m.settings_security_passkeys_count({
                  count: passkeys.data.length,
                })
              : m.settings_security_passkeys_none()}
          </Badge>
        ) : null}
      </div>
      {passkeys.isError ? (
        <div className="settings-security-row">
          <Alert tone="danger" role="alert">
            {passkeys.data
              ? m.settings_security_passkeys_stale()
              : m.settings_security_passkeys_failed()}{' '}
            <Button variant="outline" onClick={() => void passkeys.refetch()}>
              {m.common_retry()}
            </Button>
          </Alert>
        </div>
      ) : null}
      {passkeys.isPending ? (
        <p className="settings-note settings-security-row" role="status">
          {m.settings_security_passkeys_loading()}
        </p>
      ) : !passkeys.data ? null : passkeys.data.length ? (
        <ul
          className="settings-passkeys"
          aria-label={m.settings_security_passkeys_list()}
        >
          {passkeys.data.map((passkey) => (
            <li key={passkey.id} className="settings-member">
              <span className="settings-avatar" aria-hidden="true">
                <KeyRound size={14} />
              </span>
              <span className="settings-member-identity">
                <strong>{passkey.name}</strong>
                <span>
                  {passkey.createdAt
                    ? rich(
                        passkey.synced
                          ? m.settings_security_passkey_synced_added
                          : m.settings_security_passkey_device_added,
                        { date: <WorkspaceDate value={passkey.createdAt} /> },
                      )
                    : passkey.synced
                      ? m.settings_security_passkey_synced()
                      : m.settings_security_passkey_device()}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                aria-label={m.settings_security_passkey_remove_label({
                  name: passkey.name,
                })}
                onClick={() =>
                  setRemoving({ id: passkey.id, name: passkey.name })
                }
              >
                {m.common_remove()}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-note settings-security-row">
          {m.settings_security_passkeys_empty()}
        </p>
      )}
      {supported ? (
        <form
          className="settings-field settings-passkey-form"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label htmlFor={nameId}>
            {m.settings_security_passkey_name_label()}
          </label>
          <p>{m.settings_security_passkey_name_help()}</p>
          <div className="settings-passkey-add">
            <Input
              id={nameId}
              value={name}
              maxLength={200}
              autoComplete="off"
              disabled={disabled || pending}
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" disabled={disabled || pending}>
              {pending
                ? m.settings_security_passkey_waiting()
                : m.settings_security_passkey_add()}
            </Button>
          </div>
          {message ? (
            <Alert
              tone={message.tone}
              role={message.tone === 'danger' ? 'alert' : 'status'}
            >
              {message.text}
            </Alert>
          ) : null}
        </form>
      ) : (
        <div className="settings-security-row">
          <Alert tone="neutral">
            {m.settings_security_passkey_unsupported()}
          </Alert>
        </div>
      )}
      <RemovePasskeyDialog
        passkey={removing}
        onClose={() => setRemoving(null)}
        onRemoved={(removed) =>
          setMessage({
            tone: 'success',
            text: m.settings_security_passkey_removed({ name: removed }),
          })
        }
      />
    </div>
  );
}

function RemovePasskeyDialog({
  passkey,
  onClose,
  onRemoved,
}: {
  passkey: { id: string; name: string } | null;
  onClose: () => void;
  onRemoved: (name: string) => void;
}) {
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function remove() {
    if (!passkey || pending) return;
    setPending(true);
    setError('');
    try {
      const result = await auth.passkey.deletePasskey({ id: passkey.id });
      if (result.error) {
        setError(m.settings_security_passkey_remove_failed());

        return;
      }
      onRemoved(passkey.name);
      onClose();
    } catch {
      setError(m.settings_security_passkey_remove_uncertain());
    } finally {
      setPending(false);
      await client.invalidateQueries({ queryKey: passkeysKey });
      await client.invalidateQueries({ queryKey: securityActivityKey });
    }
  }

  return (
    <Dialog
      open={!!passkey}
      onOpenChange={(open) => {
        if (!open && !pending) {
          setError('');
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogTitle>{m.settings_security_passkey_remove_title()}</DialogTitle>
        <DialogDescription>
          {m.settings_security_passkey_remove_description({
            name: passkey?.name ?? '',
          })}
        </DialogDescription>
        {error ? (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        ) : null}
        <div className="settings-dialog-actions">
          <Button variant="outline" disabled={pending} onClick={onClose}>
            {m.settings_security_passkey_keep()}
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => void remove()}
          >
            {pending
              ? m.settings_security_passkey_removing()
              : m.settings_security_passkey_remove()}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type FactorStep =
  | { step: 'password' }
  | { step: 'codes'; codes: string[]; uri?: string }
  | { step: 'scan'; uri: string };

const flowCopy: Record<
  FactorFlow,
  { title: () => string; description: () => string; submit: () => string }
> = {
  enable: {
    title: m.settings_security_enable_title,
    description: m.settings_security_enable_description,
    submit: m.common_continue,
  },
  regenerate: {
    title: m.settings_security_regenerate_title,
    description: m.settings_security_regenerate_description,
    submit: m.settings_security_regenerate_submit,
  },
  disable: {
    title: m.settings_security_disable_title,
    description: m.settings_security_disable_description,
    submit: m.settings_security_turn_off,
  },
};

function FactorDialog({
  flow,
  onClose,
}: {
  flow: FactorFlow;
  onClose: (message?: string) => void;
}) {
  const client = useQueryClient();
  const [state, setState] = useState<FactorStep>({ step: 'password' });
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const copy = flowCopy[flow];

  async function finish(message: string) {
    await client.invalidateQueries({ queryKey: sessionKey });
    await client.invalidateQueries({ queryKey: securityActivityKey });
    onClose(message);
  }

  async function submit() {
    if (pending) return;
    const entered = value.replace(/\s/g, '');
    if (!entered) {
      setError(
        state.step === 'scan'
          ? m.settings_security_enter_code()
          : m.settings_security_enter_password(),
      );
      input.current?.focus();

      return;
    }
    setPending(true);
    setError('');
    try {
      if (state.step === 'scan') {
        const result = await auth.twoFactor.verifyTotp({ code: entered });
        if (result.error) {
          setError(
            result.error.status === 429
              ? m.settings_security_too_many_attempts()
              : m.settings_security_code_rejected(),
          );
          setValue('');

          return;
        }
        await finish(m.settings_security_totp_on_notice());

        return;
      }
      const result =
        flow === 'enable'
          ? await auth.twoFactor.enable({ password: value })
          : flow === 'regenerate'
            ? await auth.twoFactor.generateBackupCodes({ password: value })
            : await auth.twoFactor.disable({ password: value });
      if (result.error) {
        setError(
          result.error.status === 400
            ? m.settings_security_wrong_password()
            : result.error.status === 429
              ? m.settings_security_too_many_attempts()
              : m.settings_security_unconfirmed(),
        );

        return;
      }
      setValue('');
      const data = result.data;
      if ('totpURI' in data && data.totpURI && data.backupCodes)
        setState({ step: 'codes', codes: data.backupCodes, uri: data.totpURI });
      else if ('backupCodes' in data && data.backupCodes)
        setState({ step: 'codes', codes: data.backupCodes });
      else if (flow === 'disable')
        await finish(m.settings_security_totp_off_notice());
      else setError(m.settings_security_incomplete());
    } catch {
      setError(m.settings_security_unreachable_dialog());
    } finally {
      setPending(false);
    }
  }

  const title =
    state.step === 'codes'
      ? m.settings_security_codes_title()
      : state.step === 'scan'
        ? m.settings_security_scan_title()
        : copy.title();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) {
          if (flow === 'regenerate' && state.step === 'codes')
            onClose(m.settings_security_codes_created());
          else onClose();
        }
      }}
    >
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        {state.step === 'codes' ? (
          <>
            <DialogDescription>
              {m.settings_security_codes_description()}
            </DialogDescription>
            <BackupCodes codes={state.codes} />
            <div className="settings-save">
              {state.uri ? (
                <Button
                  onClick={() => setState({ step: 'scan', uri: state.uri! })}
                >
                  {m.settings_security_codes_saved()}
                </Button>
              ) : (
                <Button
                  onClick={() => onClose(m.settings_security_codes_created())}
                >
                  {m.common_done()}
                </Button>
              )}
            </div>
          </>
        ) : (
          <form
            className="settings-dialog-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {state.step === 'scan' ? (
              <>
                <DialogDescription>
                  {m.settings_security_scan_description()}
                </DialogDescription>
                <TotpSetup uri={state.uri} />
              </>
            ) : (
              <DialogDescription>{copy.description()}</DialogDescription>
            )}
            <label htmlFor={inputId}>
              {state.step === 'scan'
                ? m.settings_security_code_label()
                : m.settings_security_password_label()}
            </label>
            <Input
              ref={input}
              id={inputId}
              type={state.step === 'scan' ? 'text' : 'password'}
              autoComplete={
                state.step === 'scan' ? 'one-time-code' : 'current-password'
              }
              inputMode={state.step === 'scan' ? 'numeric' : undefined}
              maxLength={state.step === 'scan' ? 8 : undefined}
              value={value}
              disabled={pending}
              aria-invalid={!!error}
              onChange={(event) => setValue(event.target.value)}
            />
            {error ? (
              <Alert tone="danger" role="alert">
                {error}
              </Alert>
            ) : null}
            <div className="settings-dialog-actions">
              <Button
                variant="outline"
                type="button"
                disabled={pending}
                onClick={() => onClose()}
              >
                {m.common_cancel()}
              </Button>
              <Button
                type="submit"
                variant={
                  flow === 'disable' && state.step === 'password'
                    ? 'destructive'
                    : 'default'
                }
                disabled={pending}
              >
                {pending
                  ? m.settings_security_checking()
                  : state.step === 'scan'
                    ? m.settings_security_turn_on()
                    : copy.submit()}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="settings-backup-codes">
      <ol aria-label={m.settings_security_codes_list()}>
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ol>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(codes.join('\n'))
            .then(() => setCopied(true));
        }}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? m.common_copied() : m.settings_security_copy_codes()}
      </Button>
    </div>
  );
}

function TotpSetup({ uri }: { uri: string }) {
  const secret = new URL(uri).searchParams.get('secret') ?? '';
  const qr = encode(uri, { ecc: 'M', border: 2 });
  const path = qr.data
    .flatMap((row, y) =>
      row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : '')),
    )
    .join('');

  return (
    <div className="settings-totp">
      <svg
        className="settings-totp-qr"
        viewBox={`0 0 ${qr.size} ${qr.size}`}
        role="img"
        aria-label={m.settings_security_qr_label()}
        shapeRendering="crispEdges"
      >
        <rect width={qr.size} height={qr.size} />
        <path d={path} />
      </svg>
      <div>
        <span>
          <Smartphone size={14} aria-hidden="true" />{' '}
          {m.settings_security_setup_key()}
        </span>
        <code aria-label={m.settings_security_setup_key()}>
          {secret.match(/.{1,4}/g)?.join(' ')}
        </code>
        <small>{m.settings_security_setup_key_hint()}</small>
      </div>
    </div>
  );
}
