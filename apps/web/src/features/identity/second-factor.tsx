import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { useRef, useState } from 'react';

import { auth } from './data';

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
          ? 'Enter one of your backup codes.'
          : 'Enter the 6-digit code from your authenticator app.',
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
        if (expiredCodes.has(errorCode)) {
          setExpired(true);
          setMessage('This sign-in attempt expired. Sign in again.');
        } else if (errorCode === 'ACCOUNT_TEMPORARILY_LOCKED') {
          setExpired(true);
          setMessage(
            'Too many incorrect codes. Wait 15 minutes, then sign in again.',
          );
        } else if (result.error.status === 429) {
          setMessage('Too many attempts. Wait a moment and try again.');
        } else if (result.error.status >= 500) {
          setMessage('We couldn’t check the code. Try again.');
        } else {
          setInvalid(true);
          setMessage(
            backup
              ? 'That backup code didn’t work. Each code works once.'
              : 'That code didn’t work. Check your authenticator app and try again.',
          );
        }
        setCode('');

        return;
      }
      await onVerified();
    } catch {
      setMessage(
        'We couldn’t reach the service. Check your connection and try again.',
      );
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
          Sign in again
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
          {backup ? 'Backup code' : 'Authentication code'}
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
            ? 'Each backup code works once.'
            : 'The 6-digit code shown for Luma in your authenticator app.'}
        </div>
      </div>
      <p role="status" tabIndex={-1} ref={resultRef} className="form-message">
        {pending ? 'Checking…' : message}
      </p>
      <Button size="lg" type="submit" disabled={pending}>
        {pending ? 'Checking…' : 'Verify'}
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
          {backup ? 'Use your authenticator app' : 'Use a backup code'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={pending}
          onClick={onRestart}
        >
          Start over
        </Button>
      </div>
    </form>
  );
}
