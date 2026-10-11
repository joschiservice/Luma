import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { useRef, useState } from 'react';

import { auth } from '../../kit/identity/data';

const expiredCodes = new Set([
  'INVALID_TWO_FACTOR_COOKIE',
  'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE',
]);

/**
 * Completes a password sign-in with an authenticator code or a single-use backup code. Calls
 * `onVerified` once the session exists, and `onRestart` when the challenge has expired or the
 * person wants to sign in again.
 */
export function SecondFactorForm({
  onVerified,
  onRestart,
}: {
  onVerified: () => Promise<void>;
  onRestart: () => void;
}) {
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [expired, setExpired] = useState(false);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);

  async function submit() {
    if (lock.current) return;
    const value = backup ? code.trim() : code.replace(/\s/g, '');
    if (backup ? !value : !/^\d{6}$/.test(value)) {
      setInvalid(true);
      setMessage(
        backup
          ? m.identity_factor_backup_required()
          : m.identity_factor_code_required(),
      );
      input.current?.focus();

      return;
    }
    lock.current = true;
    setPending(true);
    setMessage('');
    setInvalid(false);
    try {
      const result = backup
        ? await auth.twoFactor.verifyBackupCode({ code: value })
        : await auth.twoFactor.verifyTotp({ code: value });
      if (result.error) {
        const errorCode = result.error.code ?? '';
        if (errorCode === 'ACCOUNT_DISABLED') {
          setExpired(true);
          setMessage(m.identity_auth_account_disabled());
        } else if (expiredCodes.has(errorCode)) {
          setExpired(true);
          setMessage(m.identity_factor_expired());
        } else if (errorCode === 'ACCOUNT_TEMPORARILY_LOCKED') {
          setExpired(true);
          setMessage(m.identity_factor_locked());
        } else if (result.error.status === 429) {
          setMessage(m.identity_factor_rate_limited());
        } else if (result.error.status >= 500) {
          setMessage(m.identity_factor_unavailable());
        } else {
          setInvalid(true);
          setMessage(
            backup
              ? m.identity_factor_backup_invalid()
              : m.identity_factor_code_invalid(),
          );
        }
        setCode('');

        return;
      }
      await onVerified();
    } catch {
      setMessage(m.identity_error_network());
    } finally {
      lock.current = false;
      setPending(false);
      requestAnimationFrame(() => resultRef.current?.focus());
    }
  }

  if (expired)
    return (
      <div className="auth-factor">
        <p role="status" tabIndex={-1} ref={resultRef} className="form-message">
          {message}
        </p>
        <Button size="lg" onClick={onRestart}>
          {m.identity_factor_sign_in_again()}
        </Button>
      </div>
    );

  return (
    <form
      noValidate
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="form-field">
        <label htmlFor="verification-code">
          {backup
            ? m.identity_factor_backup_label()
            : m.identity_factor_code_label()}
        </label>
        <Input
          ref={input}
          id="verification-code"
          name="code"
          autoFocus
          autoComplete="one-time-code"
          inputMode={backup ? 'text' : 'numeric'}
          spellCheck={false}
          maxLength={backup ? 32 : 8}
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            setInvalid(false);
          }}
          aria-invalid={invalid}
          aria-describedby="verification-code-help"
          disabled={pending}
        />
        <div id="verification-code-help" className="field-help">
          {backup
            ? m.identity_factor_backup_help()
            : m.identity_factor_code_help()}
        </div>
      </div>
      <p role="status" tabIndex={-1} ref={resultRef} className="form-message">
        {pending ? m.identity_factor_checking() : message}
      </p>
      <Button size="lg" type="submit" disabled={pending}>
        {pending ? m.identity_factor_checking() : m.identity_factor_verify()}
      </Button>
      <div className="auth-factor-actions">
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={pending}
          onClick={() => {
            setBackup(!backup);
            setCode('');
            setMessage('');
            setInvalid(false);
            input.current?.focus();
          }}
        >
          {backup
            ? m.identity_factor_use_app()
            : m.identity_factor_use_backup()}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={pending}
          onClick={onRestart}
        >
          {m.identity_factor_start_over()}
        </Button>
      </div>
    </form>
  );
}
