import {
  installationCredentials,
  type InstallationInput,
  installationInput,
  type InstalledConnection,
} from '@luma/api-contract';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { useForm } from '@tanstack/react-form';
import { useRef, useState } from 'react';

import { IdentityError } from '../identity/data';
import { changeConnection, connectionError, installConnection } from './data';
import { type Provider, reads } from './presentation';

/**
 * Collects installation or replacement credentials, clears secrets after submission, and
 * blocks retries when the result is uncertain.
 */
export function SetupForm({
  provider,
  organizationId,
  connection,
  done,
}: {
  provider: Provider;
  organizationId: string;
  connection?: InstalledConnection;
  done: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const lock = useRef(false);
  const result = useRef<HTMLParagraphElement>(null);
  const [invalid, setInvalid] = useState<string[]>([]);
  const form = useForm({
    defaultValues: {
      label: '',
      shop: '',
      jtlTenantId: '',
      baseUrl: '',
      appId: '',
      appVersion: '',
      token: '',
      challengeCode: '',
      write: false,
    },
    onSubmit: async ({ value }) => {
      if (lock.current || uncertain) return;
      const credentials = {
        token: value.token,
        ...(provider === 'jtl-onprem'
          ? { challengeCode: value.challengeCode }
          : {}),
      };
      const target: InstallationInput['target'] =
        provider === 'shopify'
          ? { kind: provider, shop: value.shop.trim().toLowerCase() }
          : provider === 'jtl-cloud'
            ? { kind: provider, jtlTenantId: value.jtlTenantId.trim() }
            : {
                kind: provider,
                baseUrl: value.baseUrl.trim(),
                appId: value.appId.trim(),
                appVersion: value.appVersion.trim(),
              };
      const input = {
        label: value.label.trim(),
        target,
        credentials,
        permissions: [
          ...reads,
          ...(value.write
            ? ([
                'orders.shipping-method.read',
                'orders.shipping-method.write',
              ] as const)
            : []),
        ],
      };
      const parsed = connection
        ? installationCredentials.safeParse(credentials)
        : installationInput.safeParse(input);
      if (!parsed.success) {
        setInvalid(
          parsed.error.issues.map((issue) => String(issue.path.at(-1) ?? '')),
        );
        setMessage(
          'Check all fields. Use a myshopify.com hostname, a valid cloud tenant ID, or an HTTPS API URL ending in /. Credentials are required; on-premise also requires a challenge code.',
        );
        result.current?.focus();

        return;
      }
      setInvalid([]);
      lock.current = true;
      setPending(true);
      setMessage('');
      try {
        // Keep secrets out of Query's mutation cache and discard them after every request.
        if (connection)
          await changeConnection(
            organizationId,
            connection,
            'rotate',
            credentials,
          );
        else
          await installConnection(
            organizationId,
            installationInput.parse(input),
          );
        await done();
      } catch (error) {
        setMessage(connectionError(error));
        setUncertain(
          !(error instanceof IdentityError) ||
            error.status >= 500 ||
            error.status === 409,
        );
      } finally {
        form.setFieldValue('token', '');
        form.setFieldValue('challengeCode', '');
        lock.current = false;
        setPending(false);
        requestAnimationFrame(() => result.current?.focus());
      }
    },
  });
  const fields = connection
    ? []
    : provider === 'shopify'
      ? (['label', 'shop'] as const)
      : provider === 'jtl-cloud'
        ? (['label', 'jtlTenantId'] as const)
        : (['label', 'baseUrl', 'appId', 'appVersion'] as const);
  const labels = {
    label: 'Connection name',
    shop: 'Shop hostname',
    jtlTenantId: 'JTL Cloud tenant ID',
    baseUrl: 'HTTPS API URL',
    appId: 'App ID',
    appVersion: 'App version',
    token: 'Access token',
    challengeCode: 'Challenge code',
  };

  return (
    <form
      className="connection-setup-form"
      autoComplete="off"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <p className="field-help">
        {provider === 'shopify'
          ? 'Provide an Admin API token with read_orders, read_products, read_inventory and fulfillment access for the requested data. Older orders need read_all_orders where applicable.'
          : provider === 'jtl-cloud'
            ? 'Use the tenant ID and access token from your JTL Cloud installation. Grant access to orders, products, inventory and fulfillment.'
            : 'Register your app with JTL-Wawi. Use its token and challenge code. Your administrator must approve the API network destination.'}
      </p>
      {[
        ...fields,
        'token',
        ...(provider === 'jtl-onprem' ? (['challengeCode'] as const) : []),
      ].map((name) => (
        <form.Field key={name} name={name as keyof typeof labels}>
          {(field) => (
            <div className="form-field">
              <label htmlFor={`connection-${name}`}>
                {labels[name as keyof typeof labels]}
              </label>
              <Input
                id={`connection-${name}`}
                aria-invalid={invalid.includes(name)}
                aria-describedby="connection-result"
                name={name}
                type={
                  name === 'token' || name === 'challengeCode'
                    ? 'password'
                    : 'text'
                }
                autoComplete="off"
                required
                maxLength={
                  name === 'label' ? 120 : name === 'challengeCode' ? 30 : 4096
                }
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                disabled={pending}
                spellCheck={false}
              />
            </div>
          )}
        </form.Field>
      ))}
      {!connection ? (
        <>
          <p className="field-help">
            Requests read access to orders, products, inventory and fulfillment.
            Provider validation determines whether access can be enabled.
          </p>
          {provider !== 'shopify' ? (
            <form.Field name="write">
              {(field) => (
                <label className="connection-checkbox">
                  <input
                    type="checkbox"
                    checked={field.state.value}
                    onChange={(e) => field.handleChange(e.target.checked)}
                    disabled={pending}
                  />
                  Permit shipping-method corrections (requires salesorders.read,
                  salesorders.write and provider idempotency support)
                </label>
              )}
            </form.Field>
          ) : null}
        </>
      ) : null}
      <p id="connection-result" role="alert" ref={result} tabIndex={-1}>
        {message}
      </p>
      {uncertain ? (
        <p>Close this form and refresh the list before submitting again.</p>
      ) : null}
      <Button type="submit" disabled={pending || uncertain}>
        {pending
          ? 'Saving…'
          : connection
            ? 'Confirm replacement'
            : 'Save connection'}
      </Button>
    </form>
  );
}
