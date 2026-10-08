import { Alert, AlertDescription } from '@luma/ui/components/primitives/alert';
import { LumaLockup } from '@luma/ui/components/primitives/brand';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardHeader,
} from '@luma/ui/components/primitives/card';
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { PageHeader } from '@luma/ui/components/workspace/page-header';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';

import { staffApi } from './api';
import { Failure, Loading } from './feedback';
import { clearPrivate } from './queries';
import { loginRoute } from './router';

/** Offers only the authentication mode admitted by the server, then checks staff eligibility. */
export function LoginPage() {
  const client = useQueryClient();
  const { denied, signInFailed } = loginRoute.useSearch();
  const config = useQuery({
    queryKey: ['staff', 'config'],
    queryFn: ({ signal }) => staffApi.config(signal),
    retry: false,
  });
  const [visible, setVisible] = useState(false);
  const login = useMutation({
    mutationFn: async ({
      email,
      password,
    }: {
      email: string;
      password: string;
    }) => {
      await staffApi.signIn(email, password);
      await staffApi.session();
      await clearPrivate(client);
      window.location.replace('/');
    },
  });
  const google = useMutation({ mutationFn: staffApi.google });
  const form = useForm({
    defaultValues: { email: '', password: '' },
    onSubmit: async ({ value }) => {
      try {
        await login.mutateAsync(value);
      } catch {
        /* The mutation renders the failure. */
      } finally {
        form.setFieldValue('password', '');
      }
    },
  });

  return (
    <main className="staff-entry">
      <Card className="staff-login">
        <CardHeader className="staff-entry-heading">
          <LumaLockup />
          <PageHeader
            title="Sign in to Luma staff"
            description="Support access for authorized team members."
          />
        </CardHeader>
        <CardContent className="staff-form">
          {signInFailed ? (
            <Alert tone="warning" role="alert">
              <AlertDescription>
                Google Workspace sign-in was not completed. Try again with your
                authorized staff account. Contact your administrator if access
                is still unavailable.
              </AlertDescription>
            </Alert>
          ) : null}
          {denied ? (
            <Alert tone="warning">
              <AlertDescription>
                Your session ended or your staff access is no longer available.
                Sign in with an authorized account.
              </AlertDescription>
            </Alert>
          ) : null}
          {config.isPending ? (
            <Loading>Checking sign-in options…</Loading>
          ) : config.isError ? (
            <Failure error={config.error} retry={() => void config.refetch()} />
          ) : config.data.mode === 'google' ? (
            <>
              <p className="staff-muted">
                Use your managed Google Workspace account.
              </p>
              <Button
                disabled={google.isPending}
                onClick={() => google.mutate()}
              >
                {google.isPending
                  ? 'Opening Google…'
                  : 'Continue with Google Workspace'}
              </Button>
              {google.isError ? <Failure error={google.error} /> : null}
            </>
          ) : (
            <>
              <Alert>
                <AlertDescription>
                  Local development sign-in. This form is unavailable in
                  production.
                </AlertDescription>
              </Alert>
              <form
                className="staff-form"
                noValidate
                aria-busy={login.isPending}
                onSubmit={(event) => {
                  event.preventDefault();
                  void form.handleSubmit();
                }}
              >
                <FieldGroup>
                  {(['email', 'password'] as const).map((name) => (
                    <form.Field
                      key={name}
                      name={name}
                      validators={{
                        onChange:
                          name === 'email'
                            ? z.email('Enter a valid email address.')
                            : z.string().min(1, 'Enter your password.'),
                      }}
                    >
                      {(field) => (
                        <Field>
                          <FieldLabel htmlFor={name}>
                            {name === 'email' ? 'Email' : 'Password'}
                          </FieldLabel>
                          <Input
                            id={name}
                            name={name}
                            type={
                              name === 'email'
                                ? 'email'
                                : visible
                                  ? 'text'
                                  : 'password'
                            }
                            autoComplete={
                              name === 'email' ? 'username' : 'current-password'
                            }
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(event) =>
                              field.handleChange(event.target.value)
                            }
                            disabled={login.isPending}
                            aria-invalid={field.state.meta.errors.length > 0}
                            aria-describedby={`${name}-error`}
                          />
                          <FieldError
                            id={`${name}-error`}
                            errors={field.state.meta.errors}
                          />
                        </Field>
                      )}
                    </form.Field>
                  ))}
                </FieldGroup>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={visible}
                  onClick={() => setVisible(!visible)}
                >
                  {visible ? 'Hide password' : 'Show password'}
                </Button>
                {login.isError ? <Failure error={login.error} /> : null}
                <Button type="submit" disabled={login.isPending}>
                  {login.isPending ? 'Signing in…' : 'Sign in'}
                </Button>
              </form>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
