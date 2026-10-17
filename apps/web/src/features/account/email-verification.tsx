import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';

import { auth } from '../../kit/identity/data';
import { AuthLayout } from './auth-form';

/**
 * Asks Luma to send a new confirmation link and returns the sentence to show. The response is
 * the same for unknown and already confirmed addresses, so success names no account.
 */
export async function requestConfirmationLink(email: string) {
  const address = email.trim();
  if (!address) return m.identity_verify_enter_email();
  try {
    const result = await auth.sendVerificationEmail({ email: address });
    if (!result.error) return m.identity_verify_resent();
    if (result.error.status === 429) return m.identity_verify_rate_limited();
    if (result.error.code === 'VERIFICATION_EMAIL_NOT_ENABLED')
      return m.identity_verify_unavailable();

    return m.identity_verify_send_failed();
  } catch {
    return m.identity_verify_send_failed();
  }
}

/** A button that sends a new confirmation link to `email`, with a status line for its outcome. */
export function ResendConfirmation({ email }: { email: () => string }) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const status = useRef<HTMLParagraphElement>(null);

  async function send() {
    if (pending) return;
    setPending(true);
    setMessage('');
    setMessage(await requestConfirmationLink(email()));
    setPending(false);
    requestAnimationFrame(() => status.current?.focus());
  }

  return (
    <div>
      <Button
        variant="outline"
        type="button"
        disabled={pending}
        onClick={() => void send()}
      >
        {pending ? m.identity_verify_sending() : m.identity_verify_resend()}
      </Button>
      <p role="status" tabIndex={-1} ref={status} className="form-message">
        {message}
      </p>
    </div>
  );
}

type State = 'confirming' | 'done' | 'invalid' | 'failed';

/**
 * Confirms an email address with the token in the URL fragment. The token is removed from the
 * address bar before the request and never sent as part of a page navigation. Confirming does
 * not sign in; the person signs in afterwards.
 */
export function EmailVerification() {
  const id = useId();
  const [token, setToken] = useState(() =>
    typeof window !== 'undefined' ? window.location.hash.slice(1) : '',
  );
  const [state, setState] = useState<State>(token ? 'confirming' : 'invalid');
  const [email, setEmail] = useState('');

  useEffect(() => {
    function acceptLink() {
      const next = window.location.hash.slice(1);
      if (!next) return;
      setToken(next);
      setState('confirming');
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname,
      );
    }

    // A second email link may open in the same tab without remounting this route.
    window.addEventListener('hashchange', acceptLink);
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname,
    );

    return () => window.removeEventListener('hashchange', acceptLink);
  }, []);

  useEffect(() => {
    if (!token) return;
    let current = true;
    auth
      .verifyEmail({ query: { token } })
      .then((result) => {
        if (!current) return;
        setState(
          !result.error
            ? 'done'
            : result.error.status === 401 || result.error.status === 400
              ? 'invalid'
              : 'failed',
        );
      })
      .catch(() => current && setState('failed'));

    return () => {
      current = false;
    };
  }, [token]);

  return (
    <AuthLayout
      title={m.identity_verify_title()}
      lead={m.identity_verify_lead()}
    >
      {state === 'confirming' ? (
        <p role="status">{m.identity_verify_confirming()}</p>
      ) : state === 'done' ? (
        <Alert tone="success" role="status">
          {m.identity_verify_done()}
        </Alert>
      ) : state === 'failed' ? (
        <Alert tone="danger" role="alert">
          {m.identity_verify_failed()}
        </Alert>
      ) : (
        <>
          <Alert tone="danger" role="alert">
            {m.identity_verify_invalid()}
          </Alert>
          <div className="form-field">
            <label htmlFor={id}>{m.identity_auth_email_label()}</label>
            <Input
              id={id}
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <ResendConfirmation email={() => email} />
        </>
      )}
      <p className="auth-switch">
        <Link to="/sign-in" search={{ returnTo: '/app' }}>
          {m.identity_auth_signin_submit()}
        </Link>
      </p>
    </AuthLayout>
  );
}
