import { type InstallationInput } from '@luma/api-contract';
import type { AppUiProps } from '@luma/app-host/web';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { useForm } from '@tanstack/react-form';
import { useRef, useState } from 'react';

import {
  installationCredentials,
  installationInput,
} from '../infrastructure/installation-validation.js';

const reads = [
  'orders.read',
  'products.read',
  'inventory.read',
  'fulfillment.read',
] as const;

/**
 * Collects installation or replacement credentials, clears secrets after submission, and
 * blocks retries when the result is uncertain.
 */
export default function JtlSettings({
  connection: suppliedConnection,
  services,
  done,
}: AppUiProps) {
  // A revoked connection takes new credentials under its ID; a disconnected one is replaced.
  const connection =
    suppliedConnection && suppliedConnection.status !== 'disconnected'
      ? suppliedConnection
      : undefined;
  const [kind, setKind] = useState(
    suppliedConnection?.target.kind ?? 'jtl-cloud',
  );
  const provider = kind;
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const lock = useRef(false);
  const result = useRef<HTMLParagraphElement>(null);
  const [invalid, setInvalid] = useState<string[]>([]);
  const form = useForm({
    defaultValues: {
      label: suppliedConnection?.label ?? '',
      shop: '',
      jtlTenantId: suppliedConnection?.target.jtlTenantId ?? '',
      baseUrl: suppliedConnection?.target.baseUrl ?? '',
      appId: suppliedConnection?.target.appId ?? '',
      appVersion: suppliedConnection?.target.appVersion ?? '',
      token: '',
      challengeCode: '',
      write:
        suppliedConnection?.permissions.includes(
          'orders.shipping-method.write',
        ) ?? false,
      purchasing:
        suppliedConnection?.permissions.includes('purchase-orders.submit') ??
        false,
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
        provider === 'jtl-cloud'
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
          ...(value.purchasing
            ? ([
                'suppliers.read',
                'purchase-orders.read',
                'purchase-orders.submit',
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
          'Check all fields. Use a valid cloud tenant ID or an HTTPS API URL ending in /. Credentials are required; on-premise also requires a challenge code.',
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
        if (connection) await services.rotate(connection, credentials);
        else await services.install(installationInput.parse(input));
        await done();
      } catch (error) {
        setMessage(services.error(error));
        setUncertain(services.uncertain(error));
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
      {!connection ? (
        <label>
          Connection type
          <select
            aria-label="Connection type"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="jtl-cloud">JTL Cloud</option>
            <option value="jtl-onprem">JTL-Wawi on-premise</option>
          </select>
        </label>
      ) : null}
      <p className="field-help">
        {provider === 'jtl-cloud'
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
          {
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
          }
          <form.Field name="purchasing">
            {(field) => (
              <label className="connection-checkbox">
                <input
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(e) => field.handleChange(e.target.checked)}
                  disabled={pending}
                />
                Permit submitting approved purchase orders (requires
                suppliers.read, purchaseorders.read, purchaseorders.write and
                items.read)
              </label>
            )}
          </form.Field>
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
