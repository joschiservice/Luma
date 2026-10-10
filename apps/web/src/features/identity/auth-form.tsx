import { m } from '@luma/i18n/messages';
import { LumaLockup } from '@luma/ui/components/primitives/brand';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { LanguageSelect } from '@luma/ui/components/workspace/language-select';
import { useForm } from '@tanstack/react-form';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { KeyRound } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { z } from 'zod';

import { auth, clearPrivate, returnPath, usePasskeySupport } from './data';
import { SecondFactorForm } from './second-factor';
import { ResolutionStory } from './story';

/**
 * Renders sign-in or account creation and returns authenticated users to a validated
 * application path.
 */
export function AuthForm({
  signup,
  returnTo,
}: {
  signup: boolean;
  returnTo: string;
}) {
  const client = useQueryClient();
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [challenge, setChallenge] = useState(false);
  const passkeys = usePasskeySupport() && !signup;
  const lock = useRef(false);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const formElement = useRef<HTMLFormElement>(null);

  /** Confirms the new session, then leaves the entry page for the validated return path. */
  async function enter() {
    await clearPrivate(client);
    const session = await auth.getSession({
      fetchOptions: { cache: 'no-store' },
    });
    if (session.error) {
      setChallenge(false);
      setMessage(m.identity_auth_session_unconfirmed());

      return;
    }
    window.location.assign(
      session.data
        ? returnPath(returnTo)
        : `/sign-in?returnTo=${encodeURIComponent(returnPath(returnTo))}`,
    );
  }

  async function signInWithPasskey() {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setMessage('');
    try {
      const result = await auth.signIn.passkey();
      if (result.error) {
        setMessage(
          'code' in result.error && result.error.code === 'ACCOUNT_DISABLED'
            ? m.identity_auth_account_disabled()
            : result.error.status === 400
              ? m.identity_auth_passkey_canceled()
              : result.error.status === 401
                ? m.identity_auth_passkey_unknown()
                : m.identity_auth_passkey_failed(),
        );

        return;
      }
      await enter();
    } catch {
      setMessage(m.identity_error_network());
    } finally {
      lock.current = false;
      setPending(false);
      requestAnimationFrame(() => resultRef.current?.focus());
    }
  }

  const form = useForm({
    onSubmitInvalid: () => {
      setMessage(m.identity_auth_check_fields());
      requestAnimationFrame(() =>
        formElement.current
          ?.querySelector<HTMLInputElement>('input[aria-invalid="true"]')
          ?.focus(),
      );
    },
    defaultValues: { name: '', email: '', password: '' },
    onSubmit: async ({ value }) => {
      if (lock.current) return;
      lock.current = true;
      setPending(true);
      setMessage('');
      try {
        const result = signup
          ? await auth.signUp.email(value)
          : await auth.signIn.email({
              email: value.email,
              password: value.password,
            });
        if (result.error) {
          setMessage(
            signup
              ? m.identity_auth_signup_failed()
              : result.error.code === 'ACCOUNT_DISABLED'
                ? m.identity_auth_account_disabled()
                : result.error.status === 401
                  ? m.identity_auth_signin_invalid()
                  : result.error.status === 429
                    ? m.identity_auth_signin_rate_limited()
                    : m.identity_auth_signin_failed(),
          );

          return;
        }
        if (
          'twoFactorRedirect' in result.data &&
          result.data.twoFactorRedirect
        ) {
          setChallenge(true);

          return;
        }
        await enter();
      } catch {
        setMessage(
          signup
            ? m.identity_auth_signup_unconfirmed()
            : m.identity_error_network(),
        );
      } finally {
        form.setFieldValue('password', '');
        lock.current = false;
        setPending(false);
        requestAnimationFrame(() => resultRef.current?.focus());
      }
    },
  });

  const pendingLabel = signup
    ? m.identity_auth_creating_account()
    : m.identity_auth_signing_in();

  if (challenge)
    return (
      <AuthLayout
        title={m.identity_auth_challenge_title()}
        lead={m.identity_auth_challenge_lead()}
      >
        <SecondFactorForm
          onVerified={enter}
          onRestart={() => {
            setChallenge(false);
            setMessage('');
          }}
        />
      </AuthLayout>
    );

  return (
    <AuthLayout
      title={
        signup ? m.identity_auth_signup_title() : m.identity_auth_signin_title()
      }
      lead={
        signup ? m.identity_auth_signup_lead() : m.identity_auth_signin_lead()
      }
    >
      <form
        ref={formElement}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
        aria-busy={pending}
      >
        {(signup
          ? (['name', 'email', 'password'] as const)
          : (['email', 'password'] as const)
        ).map((name) => (
          <form.Field
            key={name}
            name={name}
            validators={{
              onChange:
                name === 'name'
                  ? z.string().trim().min(1, m.identity_auth_name_required())
                  : name === 'email'
                    ? z.email(m.identity_auth_email_invalid())
                    : z
                        .string()
                        .min(
                          signup ? 12 : 1,
                          signup
                            ? m.identity_auth_password_too_short()
                            : m.identity_auth_password_required(),
                        ),
            }}
          >
            {(field) => {
              const errors = field.state.meta.errors;

              return (
                <div className="form-field">
                  <div className="form-field-label">
                    <label htmlFor={name}>
                      {name === 'name'
                        ? m.identity_auth_name_label()
                        : name === 'email'
                          ? m.identity_auth_email_label()
                          : m.identity_auth_password_label()}
                    </label>
                    {name === 'password' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        className="form-field-toggle"
                        aria-controls="password"
                        aria-pressed={visible}
                        onClick={() => setVisible(!visible)}
                      >
                        {visible
                          ? m.identity_auth_password_hide()
                          : m.identity_auth_password_show()}
                      </Button>
                    ) : null}
                  </div>
                  <Input
                    id={name}
                    name={name}
                    autoComplete={
                      name === 'password'
                        ? signup
                          ? 'new-password'
                          : 'current-password'
                        : name
                    }
                    type={
                      name === 'password'
                        ? visible
                          ? 'text'
                          : 'password'
                        : name === 'email'
                          ? 'email'
                          : 'text'
                    }
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    aria-invalid={errors.length > 0}
                    aria-describedby={`${name}-help`}
                    disabled={pending}
                  />
                  <div id={`${name}-help`} className="field-help">
                    {errors.length
                      ? errors.map((error) => error?.message).join(' ')
                      : name === 'password' && signup
                        ? m.identity_auth_password_help()
                        : ''}
                  </div>
                </div>
              );
            }}
          </form.Field>
        ))}
        <p role="status" tabIndex={-1} ref={resultRef} className="form-message">
          {pending ? pendingLabel : message}
        </p>
        <Button size="lg" type="submit" disabled={pending}>
          {pending
            ? pendingLabel
            : signup
              ? m.identity_auth_signup_submit()
              : m.identity_auth_signin_submit()}
        </Button>
      </form>
      {!signup ? (
        <p className="auth-switch">
          <Link to="/forgot-password">{m.identity_auth_forgot_password()}</Link>
        </p>
      ) : null}
      {passkeys ? (
        <>
          <p className="auth-divider">
            <span>{m.identity_auth_divider()}</span>
          </p>
          <Button
            variant="outline"
            size="lg"
            type="button"
            disabled={pending}
            onClick={() => void signInWithPasskey()}
          >
            <KeyRound aria-hidden="true" />
            {m.identity_auth_passkey_submit()}
          </Button>
        </>
      ) : null}
      <p className="auth-switch">
        {signup ? m.identity_auth_has_account() : m.identity_auth_no_account()}{' '}
        <Link to={signup ? '/sign-in' : '/sign-up'} search={{ returnTo }}>
          {signup
            ? m.identity_auth_signin_submit()
            : m.identity_auth_signup_submit()}
        </Link>
      </p>
    </AuthLayout>
  );
}

/** Shares the entry-page layout between sign-in and account recovery. */
export function AuthLayout({
  title,
  lead,
  children,
}: {
  title: string;
  lead: string;
  children: ReactNode;
}) {
  return (
    <main className="auth-page">
      <section
        className="auth-story"
        aria-label={m.identity_auth_story_label()}
      >
        <a
          className="entry-brand"
          href="/"
          aria-label={m.identity_brand_home_label()}
        >
          <LumaLockup byAuren />
        </a>
        <div className="auth-story-copy">
          <p className="auth-story-title">{m.identity_auth_story_title()}</p>
          <p className="auth-story-lead">{m.identity_auth_story_lead()}</p>
        </div>
        <ResolutionStory />
      </section>
      <section className="auth-panel">
        <div className="auth-panel-inner">
          <span className="auth-panel-brand" aria-hidden="true">
            <LumaLockup />
          </span>
          <h1>{title}</h1>
          <p className="auth-panel-lead">{lead}</p>
          {children}
          <footer className="auth-panel-footer">
            <LanguageSelect className="auth-language" />
          </footer>
        </div>
      </section>
    </main>
  );
}
