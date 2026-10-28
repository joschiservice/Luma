import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { useForm } from '@tanstack/react-form';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useHydrated } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';

import { auth, clearPrivate } from '../../kit/identity/data';
import { AuthLayout } from './auth-form';
import { useAdoptEnteredValues } from './entered-values';

/** Requests a recovery email or consumes a reset token from a URL fragment. */
export function PasswordRecovery({ reset = false }: { reset?: boolean }) {
  const id = useId();
  const client = useQueryClient();
  const [token, setToken] = useState(() =>
    reset && typeof window !== 'undefined' ? window.location.hash.slice(1) : '',
  );
  const [message, setMessage] = useState('');
  const [done, setDone] = useState(false);
  // Before hydration a submit would bypass the handler and put the field in the URL.
  const hydrated = useHydrated();
  const formElement = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!reset) return;

    function acceptLink() {
      const nextToken = window.location.hash.slice(1);
      if (!nextToken) return;
      setToken(nextToken);
      setDone(false);
      setMessage('');
      window.history.replaceState(
        window.history.state,
        '',
        window.location.pathname,
      );
    }

    // A second email link may open in the same tab without remounting this route.
    window.addEventListener('hashchange', acceptLink);
    // The credential stays in memory and is never part of a navigation request or referrer.
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname,
    );

    return () => window.removeEventListener('hashchange', acceptLink);
  }, [reset]);
  const form = useForm({
    defaultValues: { email: '', password: '' },
    onSubmit: async ({ value }) => {
      setMessage('');
      try {
        const result = reset
          ? await auth.resetPassword({ token, newPassword: value.password })
          : await auth.requestPasswordReset({ email: value.email.trim() });
        if (result.error) {
          setMessage(
            result.error.status === 429
              ? m.identity_recovery_rate_limited()
              : result.error.code === 'RESET_PASSWORD_DISABLED'
                ? m.identity_recovery_unavailable()
                : reset
                  ? result.error.status >= 500
                    ? m.identity_recovery_reset_unconfirmed()
                    : m.identity_recovery_invalid()
                  : m.identity_recovery_failed(),
          );

          return;
        }
        if (reset) {
          setToken('');
          await clearPrivate(client);
        }
        setDone(true);
      } catch {
        setMessage(m.identity_error_network());
      } finally {
        form.setFieldValue('password', '');
      }
    },
  });
  useAdoptEnteredValues(formElement, ['email', 'password'], (name, value) =>
    form.setFieldValue(name, value),
  );

  return (
    <AuthLayout
      title={
        reset ? m.identity_recovery_reset_title() : m.identity_recovery_title()
      }
      lead={
        reset ? m.identity_recovery_reset_lead() : m.identity_recovery_lead()
      }
    >
      {done ? (
        <Alert tone="success" role="status">
          {reset
            ? m.identity_recovery_reset_done()
            : m.identity_recovery_sent()}
        </Alert>
      ) : reset && !token ? (
        <Alert tone="danger" role="alert">
          {m.identity_recovery_invalid()}
        </Alert>
      ) : (
        <form
          ref={formElement}
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field name={reset ? 'password' : 'email'}>
            {(field) => (
              <div className="form-field">
                <label htmlFor={id}>
                  {reset
                    ? m.identity_recovery_new_password()
                    : m.identity_auth_email_label()}
                </label>
                <Input
                  id={id}
                  name={reset ? 'password' : 'email'}
                  type={reset ? 'password' : 'email'}
                  autoComplete={reset ? 'new-password' : 'email'}
                  required
                  minLength={reset ? 12 : undefined}
                  maxLength={reset ? 128 : undefined}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                />
                {reset ? (
                  <p className="field-help">
                    {m.identity_auth_password_help()}
                  </p>
                ) : null}
              </div>
            )}
          </form.Field>
          {message ? (
            <Alert tone="danger" role="alert">
              {message}
            </Alert>
          ) : null}
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(pending) => (
              <Button size="lg" type="submit" disabled={pending || !hydrated}>
                {pending
                  ? m.identity_recovery_sending()
                  : reset
                    ? m.identity_recovery_reset_submit()
                    : m.identity_recovery_submit()}
              </Button>
            )}
          </form.Subscribe>
        </form>
      )}
      <p className="auth-switch">
        <Link to="/sign-in" search={{ returnTo: '/app' }}>
          {m.identity_auth_signin_submit()}
        </Link>
        {reset && !done ? (
          <>
            {' '}
            ·{' '}
            <Link to="/forgot-password">{m.identity_recovery_new_link()}</Link>
          </>
        ) : null}
      </p>
    </AuthLayout>
  );
}
