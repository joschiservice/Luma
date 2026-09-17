import { useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { Button } from '@luma/ui/button';
import { Input } from '@luma/ui/components/input';
import { auth, clearPrivate, returnPath } from './data';
import { Brand } from './common';

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
  const lock = useRef(false);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const formElement = useRef<HTMLFormElement>(null);
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
        await clearPrivate(client);
        const session = await auth.getSession({
          fetchOptions: { cache: 'no-store' },
        });
        if (session.error) {
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
  return (
    <main className="auth-page">
      <section className="auth-story">
        <Brand />
        <p className="eyebrow">The Exception Desk</p>
        <h1>
          Clarity for
          <br />
          the work ahead.
        </h1>
        <p>
          One workspace for your operations.
          <br />A clear place to begin.
        </p>
        <span className="folio">LUMA / WORKSPACE</span>
      </section>
      <section className="auth-panel">
        <p className="eyebrow">
          {signup ? 'Make yourself at home' : 'Welcome back'}
        </p>
        <h2>{signup ? 'Create your account' : 'Sign in to Luma'}</h2>
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
                    <label htmlFor={name}>
                      {name === 'name'
                        ? 'Name'
                        : name === 'email'
                          ? 'Email'
                          : 'Password'}
                    </label>
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
                    {name === 'password' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        aria-controls="password"
                        aria-pressed={visible}
                        onClick={() => setVisible(!visible)}
                      >
                        {visible ? 'Hide password' : 'Show password'}
                      </Button>
                    ) : null}
                  </div>
                );
              }}
            </form.Field>
          ))}
          <p
            role="status"
            tabIndex={-1}
            ref={resultRef}
            className="form-message"
          >
            {pending ? 'Please wait…' : message}
          </p>
          <Button type="submit" disabled={pending}>
            {pending ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}
          </Button>
        </form>
        <p>
          {signup ? 'Already have an account?' : 'New to Luma?'}{' '}
          <Link to={signup ? '/sign-in' : '/sign-up'} search={{ returnTo }}>
            {signup ? 'Sign in' : 'Create account'}
          </Link>
        </p>
      </section>
    </main>
  );
}
