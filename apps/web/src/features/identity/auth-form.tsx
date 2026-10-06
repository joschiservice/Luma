import { LumaLockup } from '@luma/ui/components/primitives/brand';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
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
      setMessage(
        'Your account request succeeded, but we couldn’t confirm your session. Try signing in.',
      );

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
          result.error.status === 400
            ? 'Passkey sign-in was cancelled or timed out. Try again, or sign in with your email and password.'
            : result.error.status === 401
              ? 'That passkey isn’t registered with Luma. Sign in with your email and password.'
              : 'Passkey sign-in failed. Try again when the service is available.',
        );

        return;
      }
      await enter();
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

  const form = useForm({
    onSubmitInvalid: () => {
      setMessage('Check the highlighted fields.');
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
              ? 'Account creation was not confirmed. Try signing in if you may already have an account, or check your details and retry.'
              : 'Sign-in failed. Check your email and password, or try again when the service is available.',
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
            ? 'Account creation was not confirmed. Check your connection. Try signing in before creating another account.'
            : 'We couldn’t reach the service. Check your connection and try again.',
        );
      } finally {
        form.setFieldValue('password', '');
        lock.current = false;
        setPending(false);
        requestAnimationFrame(() => resultRef.current?.focus());
      }
    },
  });

  if (challenge)
    return (
      <AuthLayout
        title="Confirm it’s you"
        lead="Your account uses two-factor authentication."
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
      title={signup ? 'Create your account' : 'Sign in to Luma'}
      lead={
        signup
          ? 'Create your account, then set up or join a workspace.'
          : 'Welcome back. Pick up where you left off.'
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
                  ? z.string().trim().min(1, 'Enter your name.')
                  : name === 'email'
                    ? z.email('Enter a valid email address.')
                    : z
                        .string()
                        .min(
                          signup ? 12 : 1,
                          signup
                            ? 'Use at least 12 characters.'
                            : 'Enter your password.',
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
                        ? 'Name'
                        : name === 'email'
                          ? 'Email'
                          : 'Password'}
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
                        {visible ? 'Hide password' : 'Show password'}
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
                        ? 'At least 12 characters.'
                        : ''}
                  </div>
                </div>
              );
            }}
          </form.Field>
        ))}
        <p role="status" tabIndex={-1} ref={resultRef} className="form-message">
          {pending ? 'Please wait…' : message}
        </p>
        <Button size="lg" type="submit" disabled={pending}>
          {pending ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}
        </Button>
      </form>
      {passkeys ? (
        <>
          <p className="auth-divider">
            <span>or</span>
          </p>
          <Button
            variant="outline"
            size="lg"
            type="button"
            disabled={pending}
            onClick={() => void signInWithPasskey()}
          >
            <KeyRound aria-hidden="true" />
            Sign in with a passkey
          </Button>
        </>
      ) : null}
      <p className="auth-switch">
        {signup ? 'Already have an account?' : 'New to Luma?'}{' '}
        <Link to={signup ? '/sign-in' : '/sign-up'} search={{ returnTo }}>
          {signup ? 'Sign in' : 'Create account'}
        </Link>
      </p>
    </AuthLayout>
  );
}

function AuthLayout({
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
      <section className="auth-story" aria-label="About Luma">
        <a className="entry-brand" href="/" aria-label="Luma home">
          <LumaLockup byAuren />
        </a>
        <div className="auth-story-copy">
          <p className="auth-story-title">
            Spend less time fixing the same order problems.
          </p>
          <p className="auth-story-lead">
            Luma investigates problems across the systems you already use, makes
            the changes you’ve agreed on, and checks that the fix worked.
          </p>
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
        </div>
      </section>
    </main>
  );
}
