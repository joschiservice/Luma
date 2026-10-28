import { m } from '@luma/i18n/messages';
import { LumaLockup } from '@luma/ui/components/primitives/brand';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { LanguageSelect } from '@luma/ui/components/workspace/language-select';
import { useForm } from '@tanstack/react-form';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useHydrated } from '@tanstack/react-router';
import { KeyRound } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { z } from 'zod';

import {
  auth,
  clearPrivate,
  type DataRegion,
  returnPath,
  signUpInRegion,
  usePasskeySupport,
} from '../../kit/identity/data';
import { regionLabel } from '../../kit/identity/region';
import { ResendConfirmation } from './email-verification';
import { useAdoptEnteredValues } from './entered-values';
import { RegionChoice } from './region-choice';
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
  const [confirmedRegion, setConfirmedRegion] = useState<DataRegion>();
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [challenge, setChallenge] = useState(false);
  // Set after sign-up: the address the confirmation link went to.
  const [sentTo, setSentTo] = useState<string>();
  // Set when a sign-in was refused because the account's address isn't confirmed.
  const [unconfirmed, setUnconfirmed] = useState(false);
  // Before hydration a submit would bypass the handler and put the fields in the URL.
  const hydrated = useHydrated();
  // Support is known only in the browser; the button is always rendered so the form doesn't shift.
  const passkeysSupported = usePasskeySupport();
  const passkeysUnsupported = hydrated && !passkeysSupported;
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
    setUnconfirmed(false);
    try {
      const result = await auth.signIn.passkey();
      if (result.error) {
        const code = 'code' in result.error ? result.error.code : undefined;
        setUnconfirmed(code === 'EMAIL_NOT_VERIFIED');
        setMessage(
          code === 'ACCOUNT_DISABLED'
            ? m.identity_auth_account_disabled()
            : code === 'EMAIL_NOT_VERIFIED'
              ? m.identity_auth_email_not_verified()
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
      if (lock.current || (signup && !confirmedRegion)) return;
      lock.current = true;
      setPending(true);
      setMessage('');
      setUnconfirmed(false);
      try {
        const result = signup
          ? await signUpInRegion(value, confirmedRegion!)
          : await auth.signIn.email({
              email: value.email,
              password: value.password,
            });
        if (result.error) {
          const code = result.error.code;
          setUnconfirmed(!signup && code === 'EMAIL_NOT_VERIFIED');
          setMessage(
            signup
              ? m.identity_auth_signup_failed()
              : code === 'ACCOUNT_DISABLED'
                ? m.identity_auth_account_disabled()
                : code === 'EMAIL_NOT_VERIFIED'
                  ? m.identity_auth_email_not_verified()
                  : code === 'SIGN_IN_LOCKED'
                    ? m.identity_auth_signin_locked()
                    : result.error.status === 401
                      ? m.identity_auth_signin_invalid()
                      : result.error.status === 429
                        ? m.identity_auth_signin_rate_limited()
                        : m.identity_auth_signin_failed(),
          );

          return;
        }
        // A new account has no session until its address is confirmed.
        if (signup) {
          setSentTo(value.email.trim());

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

  useAdoptEnteredValues(
    formElement,
    ['name', 'email', 'password'],
    (name, value) => form.setFieldValue(name, value),
  );

  const pendingLabel = signup
    ? m.identity_auth_creating_account()
    : m.identity_auth_signing_in();

  if (signup && sentTo)
    return (
      <AuthLayout
        title={m.identity_verify_sent_title()}
        lead={m.identity_verify_sent_lead({ email: sentTo })}
      >
        <ResendConfirmation email={() => sentTo} />
        <p className="auth-switch">
          <Link to="/sign-in" search={{ returnTo }}>
            {m.identity_auth_signin_submit()}
          </Link>
        </p>
      </AuthLayout>
    );

  if (signup && !confirmedRegion)
    return (
      <AuthLayout
        title={m.identity_region_title()}
        lead={m.identity_region_lead()}
      >
        <RegionChoice returnTo={returnTo} onConfirm={setConfirmedRegion} />
        <p className="auth-switch">
          <Link to="/sign-in" search={{ returnTo }}>
            {m.identity_auth_signin_submit()}
          </Link>
        </p>
      </AuthLayout>
    );

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
      {signup && confirmedRegion ? (
        <div className="auth-region-confirmed">
          <p>
            {m.identity_region_confirmed({
              region: regionLabel(confirmedRegion),
            })}
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => setConfirmedRegion(undefined)}
          >
            {m.identity_region_change()}
          </Button>
        </div>
      ) : null}
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
                    autoFocus={signup && name === 'name'}
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
        {unconfirmed && !pending ? (
          <ResendConfirmation email={() => form.getFieldValue('email')} />
        ) : null}
        <Button size="lg" type="submit" disabled={pending || !hydrated}>
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
      {!signup ? (
        <>
          <p className="auth-divider">
            <span>{m.identity_auth_divider()}</span>
          </p>
          <Button
            variant="outline"
            size="lg"
            type="button"
            disabled={pending || !hydrated || passkeysUnsupported}
            aria-describedby={
              passkeysUnsupported ? 'passkey-unsupported' : undefined
            }
            onClick={() => void signInWithPasskey()}
          >
            <KeyRound aria-hidden="true" />
            {m.identity_auth_passkey_submit()}
          </Button>
          {passkeysUnsupported ? (
            <p id="passkey-unsupported" className="field-help">
              {m.identity_auth_passkey_unsupported()}
            </p>
          ) : null}
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
