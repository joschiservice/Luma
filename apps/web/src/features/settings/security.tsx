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

import { privateQueryDefaults } from '../../lib/private-query';
import {
  auth,
  IdentityError,
  sessionKey,
  sessionOptions,
  usePasskeySupport,
} from '../identity/data';
import { SectionHeading } from './section-heading';

export const passkeysKey = ['private', 'passkeys'] as const;

/** Lists the signed-in person's passkeys; rejects failed reads with their HTTP status. */
export const passkeysOptions = () =>
  queryOptions({
    ...privateQueryDefaults,
    queryKey: passkeysKey,
    queryFn: async ({ signal }) => {
      const result = await auth.passkey.listUserPasskeys({
        fetchOptions: { signal, cache: 'no-store' },
      });
      if (result.error)
        throw new IdentityError(result.error.status, result.error);

      return result.data.map((passkey) => ({
        id: passkey.id,
        name: passkey.name?.trim() || 'Passkey',
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
        title="Security"
        description="How you sign in. These settings apply to your account in every workspace."
        badge="Your account"
      />
      <div className="settings-panel">
        <div className="settings-panel-heading">
          <div>
            <h3>Authenticator app</h3>
            <p>
              After your password, Luma asks for a 6-digit code from an app such
              as 1Password, Google Authenticator or Microsoft Authenticator.
            </p>
          </div>
          {session.data ? (
            <Badge tone={enabled ? 'success' : 'neutral'}>
              {enabled ? 'On' : 'Off'}
            </Badge>
          ) : null}
        </div>
        <div className="settings-preference">
          <span>
            <strong>
              {enabled ? 'Two-factor authentication is on' : 'Not set up'}
            </strong>
            <span>
              {enabled
                ? 'Keep your backup codes safe. You can use each one once if your device isn’t available.'
                : 'Add a second step so a password alone can’t open your account.'}
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
                  New backup codes
                </Button>
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() => setFlow('disable')}
                >
                  Turn off
                </Button>
              </>
            ) : (
              <Button
                disabled={disabled || !session.data}
                onClick={() => setFlow('enable')}
              >
                Set up
              </Button>
            )}
          </div>
        </div>
        <p className="settings-note settings-security-notice" role="status">
          {notice}
        </p>
      </div>
      <PasskeySettings disabled={disabled} />
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
              ? 'For your security, sign out and sign in again before adding a passkey.'
              : code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED'
                ? 'This device or password manager already has a passkey for your account.'
                : result.error.status >= 500
                  ? 'The passkey couldn’t be saved. Try again.'
                  : 'Passkey setup was cancelled or timed out.',
        });

        return;
      }
      setName('');
      setMessage({ tone: 'success', text: 'Passkey added.' });
    } catch {
      setMessage({
        tone: 'danger',
        text: 'We couldn’t reach the service. Check your connection and try again.',
      });
    } finally {
      setPending(false);
      await client.invalidateQueries({ queryKey: passkeysKey });
    }
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel-heading">
        <div>
          <h3>Passkeys</h3>
          <p>
            Sign in with your fingerprint, face, device PIN or a security key
            instead of your password. Signing in with a passkey skips the code
            step.
          </p>
        </div>
        {passkeys.data ? (
          <Badge tone={passkeys.data.length ? 'success' : 'neutral'}>
            {passkeys.data.length
              ? `${passkeys.data.length} added`
              : 'None added'}
          </Badge>
        ) : null}
      </div>
      {passkeys.isError ? (
        <div className="settings-security-row">
          <Alert tone="danger" role="alert">
            {passkeys.data
              ? 'Passkeys could not be refreshed. This list may be out of date.'
              : 'Passkeys could not be loaded.'}{' '}
            <Button variant="outline" onClick={() => void passkeys.refetch()}>
              Retry
            </Button>
          </Alert>
        </div>
      ) : null}
      {passkeys.isPending ? (
        <p className="settings-note settings-security-row" role="status">
          Loading passkeys…
        </p>
      ) : !passkeys.data ? null : passkeys.data.length ? (
        <ul className="settings-passkeys" aria-label="Your passkeys">
          {passkeys.data.map((passkey) => (
            <li key={passkey.id} className="settings-member">
              <span className="settings-avatar" aria-hidden="true">
                <KeyRound size={14} />
              </span>
              <span className="settings-member-identity">
                <strong>{passkey.name}</strong>
                <span>
                  {passkey.synced ? 'Synced passkey' : 'Device-bound passkey'}
                  {passkey.createdAt ? (
                    <>
                      {' · Added '}
                      <WorkspaceDate value={passkey.createdAt} />
                    </>
                  ) : null}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled}
                aria-label={`Remove ${passkey.name}`}
                onClick={() =>
                  setRemoving({ id: passkey.id, name: passkey.name })
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="settings-note settings-security-row">
          No passkeys yet. Add one on each device you sign in from.
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
          <label htmlFor={nameId}>Name (optional)</label>
          <p>Helps you recognize it later, for example “Work laptop”.</p>
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
              {pending ? 'Waiting for your device…' : 'Add passkey'}
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
            This browser can’t create passkeys. Use a current version of Chrome,
            Edge, Firefox or Safari.
          </Alert>
        </div>
      )}
      <RemovePasskeyDialog
        passkey={removing}
        onClose={() => setRemoving(null)}
        onRemoved={(removed) =>
          setMessage({ tone: 'success', text: `${removed} removed.` })
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
        setError('The passkey couldn’t be removed. Try again.');

        return;
      }
      onRemoved(passkey.name);
      onClose();
    } catch {
      setError(
        'We couldn’t confirm the removal. Check your connection; the list shows the current state.',
      );
    } finally {
      setPending(false);
      await client.invalidateQueries({ queryKey: passkeysKey });
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
        <DialogTitle>Remove passkey?</DialogTitle>
        <DialogDescription>
          You won’t be able to sign in with “{passkey?.name}” anymore. Also
          delete it from your device or password manager.
        </DialogDescription>
        {error ? (
          <Alert tone="danger" role="alert">
            {error}
          </Alert>
        ) : null}
        <div className="settings-dialog-actions">
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Keep passkey
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => void remove()}
          >
            {pending ? 'Removing…' : 'Remove passkey'}
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
  { title: string; description: string; submit: string }
> = {
  enable: {
    title: 'Set up an authenticator app',
    description: 'Confirm your password to start.',
    submit: 'Continue',
  },
  regenerate: {
    title: 'Create new backup codes',
    description: 'Your current backup codes stop working.',
    submit: 'Create codes',
  },
  disable: {
    title: 'Turn off two-factor authentication?',
    description:
      'Signing in will only need your password. Your backup codes stop working.',
    submit: 'Turn off',
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
    onClose(message);
  }

  async function submit() {
    if (pending) return;
    const entered = value.replace(/\s/g, '');
    if (!entered) {
      setError(
        state.step === 'scan'
          ? 'Enter the 6-digit code.'
          : 'Enter your password.',
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
              ? 'Too many attempts. Wait a moment and try again.'
              : 'That code didn’t work. Check that your device’s time is set automatically, then enter the current code.',
          );
          setValue('');

          return;
        }
        await finish('Two-factor authentication is on.');

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
            ? 'That password isn’t correct.'
            : result.error.status === 429
              ? 'Too many attempts. Wait a moment and try again.'
              : 'The change couldn’t be confirmed. Close this dialog to see the current state, then try again.',
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
        await finish('Two-factor authentication is off.');
      else
        setError(
          'The response was incomplete. Close this dialog to see the current state, then try again.',
        );
    } catch {
      setError(
        'We couldn’t reach the service. Close this dialog to see the current state, then try again.',
      );
    } finally {
      setPending(false);
    }
  }

  const title =
    state.step === 'codes'
      ? 'Save your backup codes'
      : state.step === 'scan'
        ? 'Scan with your authenticator app'
        : copy.title;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) {
          if (flow === 'regenerate' && state.step === 'codes')
            onClose('New backup codes created.');
          else onClose();
        }
      }}
    >
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        {state.step === 'codes' ? (
          <>
            <DialogDescription>
              Store these somewhere safe, like your password manager. Each code
              works once if your authenticator app isn’t available. You won’t
              see them again.
            </DialogDescription>
            <BackupCodes codes={state.codes} />
            <div className="settings-save">
              {state.uri ? (
                <Button
                  onClick={() => setState({ step: 'scan', uri: state.uri! })}
                >
                  I’ve saved my codes
                </Button>
              ) : (
                <Button onClick={() => onClose('New backup codes created.')}>
                  Done
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
                  Scan the code, or enter the setup key, then enter the 6-digit
                  code the app shows. Two-factor authentication starts once the
                  code is confirmed.
                </DialogDescription>
                <TotpSetup uri={state.uri} />
              </>
            ) : (
              <DialogDescription>{copy.description}</DialogDescription>
            )}
            <label htmlFor={inputId}>
              {state.step === 'scan' ? 'Authentication code' : 'Password'}
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
                Cancel
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
                  ? 'Checking…'
                  : state.step === 'scan'
                    ? 'Turn on'
                    : copy.submit}
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
      <ol aria-label="Backup codes">
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
        {copied ? 'Copied' : 'Copy codes'}
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
        aria-label="QR code for your authenticator app"
        shapeRendering="crispEdges"
      >
        <rect width={qr.size} height={qr.size} />
        <path d={path} />
      </svg>
      <div>
        <span>
          <Smartphone size={14} aria-hidden="true" /> Setup key
        </span>
        <code aria-label="Setup key">{secret.match(/.{1,4}/g)?.join(' ')}</code>
        <small>Time-based, 6 digits.</small>
      </div>
    </div>
  );
}
