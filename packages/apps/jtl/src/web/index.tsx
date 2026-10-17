import { type InstallationInput } from '@luma/api-contract';
import type { AppUiProps } from '@luma/app-host/web';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { useForm } from '@tanstack/react-form';
import { useRef, useState } from 'react';

import {
  installationCredentials,
  installationInput,
} from '../domain/installation-validation.js';

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
      returns:
        suppliedConnection?.permissions.includes('returns.create') ?? false,
      exchanges:
        suppliedConnection?.permissions.includes(
          'returns.exchange.reservation.read',
        ) ?? false,
      customers:
        suppliedConnection?.permissions.includes('customers.read') ?? false,
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
                'purchase-orders.revise',
              ] as const)
            : []),
          ...(value.returns
            ? ([
                'returns.options.read',
                'returns.created.read',
                'returns.create',
              ] as const)
            : []),
          ...(value.exchanges
            ? (['returns.exchange.reservation.read'] as const)
            : []),
          ...(value.customers ? (['customers.read'] as const) : []),
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
          connection
            ? provider === 'jtl-onprem'
              ? m.jtl_setup_invalid_replace_onprem()
              : m.jtl_setup_invalid_replace_cloud()
            : provider === 'jtl-onprem'
              ? m.jtl_setup_invalid_onprem()
              : m.jtl_setup_invalid_cloud(),
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
    label: m.jtl_setup_label_name,
    shop: m.jtl_setup_label_shop,
    jtlTenantId: m.jtl_setup_label_tenant,
    baseUrl: m.jtl_setup_label_base_url,
    appId: m.jtl_setup_label_app_id,
    appVersion: m.jtl_setup_label_app_version,
    token: m.jtl_setup_label_token,
    challengeCode: m.jtl_setup_label_challenge,
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
          {m.jtl_setup_type_label()}
          <select
            aria-label={m.jtl_setup_type_label()}
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="jtl-cloud">{m.jtl_setup_type_cloud()}</option>
            <option value="jtl-onprem">{m.jtl_setup_type_onprem()}</option>
          </select>
        </label>
      ) : null}
      <p className="field-help">
        {provider === 'jtl-cloud'
          ? m.jtl_setup_help_cloud()
          : m.jtl_setup_help_onprem()}
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
                {labels[name as keyof typeof labels]()}
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
          <p className="field-help">{m.jtl_setup_read_access()}</p>
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
                  {m.jtl_setup_shipping_write()}
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
                {m.jtl_setup_purchasing()}
              </label>
            )}
          </form.Field>
          <form.Field name="returns">
            {(field) => (
              <label className="connection-checkbox">
                <input
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(e) => field.handleChange(e.target.checked)}
                  disabled={pending}
                />
                {m.jtl_setup_returns()}
              </label>
            )}
          </form.Field>
          <form.Field name="exchanges">
            {(field) => (
              <label className="connection-checkbox">
                <input
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(e) => field.handleChange(e.target.checked)}
                  disabled={pending}
                />
                {m.jtl_setup_exchanges()}
              </label>
            )}
          </form.Field>
          <form.Field name="customers">
            {(field) => (
              <label className="connection-checkbox">
                <input
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(e) => field.handleChange(e.target.checked)}
                  disabled={pending}
                />
                {m.jtl_setup_customers()}
              </label>
            )}
          </form.Field>
        </>
      ) : null}
      <p id="connection-result" role="alert" ref={result} tabIndex={-1}>
        {message}
      </p>
      {uncertain ? <p>{m.jtl_setup_uncertain()}</p> : null}
      <Button type="submit" disabled={pending || uncertain}>
        {pending
          ? m.common_saving()
          : connection
            ? m.jtl_setup_confirm_replacement()
            : m.jtl_setup_save()}
      </Button>
    </form>
  );
}
