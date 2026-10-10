import type { AppUiProps } from '@luma/app-host/web';
import { m } from '@luma/i18n/messages';
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
  'returns.read',
  'suppliers.read',
  'purchase-orders.read',
] as const;

/**
 * Collects a Cin7 Core account ID and API application key, or a replacement key. Clears the key
 * after submission and blocks retries when the result is uncertain.
 */
export default function Cin7Settings({
  connection: suppliedConnection,
  services,
  done,
}: AppUiProps) {
  // A revoked connection takes a new key under its ID; a disconnected one is replaced.
  const connection =
    suppliedConnection && suppliedConnection.status !== 'disconnected'
      ? suppliedConnection
      : undefined;
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [invalid, setInvalid] = useState<string[]>([]);
  const lock = useRef(false);
  const result = useRef<HTMLParagraphElement>(null);
  const form = useForm({
    defaultValues: {
      label: suppliedConnection?.label ?? '',
      accountId: suppliedConnection?.target.accountId ?? '',
      token: '',
      customers:
        suppliedConnection?.permissions.includes('customers.read') ?? false,
    },
    onSubmit: async ({ value }) => {
      if (lock.current || uncertain) return;
      const credentials = { token: value.token };
      const input = {
        label: value.label.trim(),
        target: { kind: 'cin7-core', accountId: value.accountId.trim() },
        credentials,
        permissions: [
          ...reads,
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
          connection ? m.cin7_setup_invalid_replace() : m.cin7_setup_invalid(),
        );
        result.current?.focus();

        return;
      }
      setInvalid([]);
      lock.current = true;
      setPending(true);
      setMessage('');
      try {
        // Keep the key out of Query's mutation cache and discard it after every request.
        if (connection) await services.rotate(connection, credentials);
        else await services.install(installationInput.parse(input));
        await done();
      } catch (error) {
        setMessage(services.error(error));
        setUncertain(services.uncertain(error));
      } finally {
        form.setFieldValue('token', '');
        lock.current = false;
        setPending(false);
        requestAnimationFrame(() => result.current?.focus());
      }
    },
  });
  const labels = {
    label: m.cin7_setup_label_name,
    accountId: m.cin7_setup_label_account,
    token: m.cin7_setup_label_key,
  };
  const fields = connection
    ? (['token'] as const)
    : (['label', 'accountId', 'token'] as const);

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
      <p className="field-help">{m.cin7_setup_help()}</p>
      {fields.map((name) => (
        <form.Field key={name} name={name}>
          {(field) => (
            <div className="form-field">
              <label htmlFor={`connection-${name}`}>{labels[name]()}</label>
              <Input
                id={`connection-${name}`}
                aria-invalid={invalid.includes(name)}
                aria-describedby="connection-result"
                name={name}
                type={name === 'token' ? 'password' : 'text'}
                autoComplete="off"
                required
                maxLength={name === 'label' ? 120 : 4096}
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
          <p className="field-help">{m.cin7_setup_read_access()}</p>
          <form.Field name="customers">
            {(field) => (
              <label className="connection-checkbox">
                <input
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(e) => field.handleChange(e.target.checked)}
                  disabled={pending}
                />
                {m.cin7_setup_customers()}
              </label>
            )}
          </form.Field>
        </>
      ) : null}
      <p id="connection-result" role="alert" ref={result} tabIndex={-1}>
        {message}
      </p>
      {uncertain ? <p>{m.cin7_setup_uncertain()}</p> : null}
      <Button type="submit" disabled={pending || uncertain}>
        {pending
          ? m.common_saving()
          : connection
            ? m.cin7_setup_confirm_replacement()
            : m.cin7_setup_save()}
      </Button>
    </form>
  );
}
