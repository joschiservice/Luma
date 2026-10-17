import type { AppUiProps } from '@luma/app-host/web';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { z } from 'zod';

import {
  installationCredentials,
  installationInput,
} from '../domain/installation-validation.js';

/** Presents secret-safe setup or the exact downstream correction supplied by a canonical order plan. */
export default function StarshipitSettings(props: AppUiProps) {
  if (props.slot === 'record')
    return props.record && props.can('starshipit:order_update.run') ? (
      <Corrections
        key={`${props.record.connectionId}:${props.record.externalId}`}
        {...props}
      />
    ) : null;

  return <Setup {...props} />;
}

function Setup({ connection, services, done }: AppUiProps) {
  const [values, setValues] = useState({
    label: connection?.label ?? '',
    accountId: connection?.target.accountId ?? '',
    token: '',
    subscriptionKey: '',
    webhookSecret: '',
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const lock = useRef(false);
  const replacing = connection && connection.status !== 'disconnected';
  const labels = {
    label: m.cin7_setup_label_name,
    accountId: m.starshipit_setup_account,
    token: m.starshipit_setup_api_key,
    subscriptionKey: m.starshipit_setup_subscription_key,
    webhookSecret: m.starshipit_setup_webhook_secret,
  };
  const names = replacing
    ? (['token', 'subscriptionKey', 'webhookSecret'] as const)
    : ([
        'label',
        'accountId',
        'token',
        'subscriptionKey',
        'webhookSecret',
      ] as const);

  return (
    <form
      className="connection-setup-form"
      autoComplete="off"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        if (lock.current || uncertain) return;
        const credentials = {
          token: values.token,
          subscriptionKey: values.subscriptionKey,
          ...(values.webhookSecret
            ? { webhookSecret: values.webhookSecret }
            : {}),
        };
        const input = {
          label: values.label,
          target: { kind: 'starshipit', accountId: values.accountId },
          credentials,
          permissions: ['orders.read', 'fulfillment.read'],
        };
        const parsed = replacing
          ? installationCredentials.safeParse(credentials)
          : installationInput.safeParse(input);
        if (!parsed.success) {
          setError(m.starshipit_setup_invalid());

          return;
        }
        lock.current = true;
        setPending(true);
        setError('');
        (replacing
          ? services.rotate(connection, credentials)
          : services.install(installationInput.parse(input))
        )
          .then(done)
          .catch((failure: unknown) => {
            setError(services.error(failure));
            setUncertain(services.uncertain(failure));
          })
          .finally(() => {
            setValues((old) => ({
              ...old,
              token: '',
              subscriptionKey: '',
              webhookSecret: '',
            }));
            lock.current = false;
            setPending(false);
          });
      }}
    >
      <p className="field-help">{m.starshipit_setup_help()}</p>
      {names.map((name) => (
        <div className="form-field" key={name}>
          <label htmlFor={`starshipit-${name}`}>{labels[name]()}</label>
          <Input
            id={`starshipit-${name}`}
            value={values[name]}
            onChange={(event) =>
              setValues((old) => ({ ...old, [name]: event.target.value }))
            }
            type={
              name === 'label' || name === 'accountId' ? 'text' : 'password'
            }
            required={name !== 'webhookSecret'}
            autoComplete="off"
            disabled={pending}
            maxLength={name === 'label' || name === 'accountId' ? 120 : 4096}
            spellCheck={false}
          />
        </div>
      ))}
      {!replacing ? (
        <p className="field-help">{m.starshipit_setup_readonly()}</p>
      ) : null}
      <p role="alert">{error}</p>
      {uncertain ? <p>{m.starshipit_setup_uncertain()}</p> : null}
      <Button disabled={pending || uncertain} type="submit">
        {pending ? m.common_saving() : m.cin7_setup_save()}
      </Button>
    </form>
  );
}

const updateSchema = z.object({
  id: z.string().uuid(),
  lines: z.array(
    z.object({
      lineItemId: z.string(),
      currentQuantity: z.number(),
      quantity: z.number(),
    }),
  ),
  state: z.enum([
    'preview',
    'approved',
    'approval_required',
    'uncertain',
    'unavailable',
    'verified',
    'denied',
    'not_executed',
  ]),
  observeOnly: z.boolean(),
  canExecute: z.boolean(),
  canApprove: z.boolean(),
  canCheck: z.boolean(),
});
const inspectionSchema = z.object({
  enabled: z.boolean(),
  status: z.string().nullable(),
  lines: z.array(
    z.object({
      lineItemId: z.string(),
      title: z.string().nullable(),
      sku: z.string().nullable(),
      quantity: z.number(),
    }),
  ),
  updates: z.array(updateSchema),
});
const messages = {
  approved: m.starshipit_update_approved,
  preview: m.starshipit_update_preview,
  approval_required: m.starshipit_update_approval_required,
  uncertain: m.starshipit_update_uncertain,
  verified: m.starshipit_update_verified,
  denied: m.starshipit_update_denied,
  unavailable: m.starshipit_update_evidence_unavailable,
  not_executed: m.starshipit_update_not_executed,
};

function Corrections({ record, services, organizationId }: AppUiProps) {
  const [selected, setSelected] = useState<z.infer<typeof updateSchema> | null>(
    null,
  );
  const requestId = useRef<string | null>(null);
  const connectionId = record?.connectionId;
  const orderId = record?.externalId;
  const queryClient = useQueryClient();
  const queryKey = [
    'private',
    'organization',
    organizationId,
    'apps',
    'starshipit',
    'order-update',
    connectionId,
    orderId,
  ];
  const inspection = useQuery({
    queryKey,
    enabled: !!connectionId && !!orderId,
    queryFn: async () =>
      inspectionSchema.parse(
        await services.request('order-update-inspect', {
          connectionId,
          orderId,
        }),
      ),
    staleTime: 10000,
  });
  const data = inspection.data;
  const planned = (record?.change?.lines ?? []).map((line) => ({
    lineItemId: line.externalId,
    quantity: Number(line.quantity),
  }));
  const valid =
    planned.length > 0 &&
    planned.every(
      (line) =>
        Number.isSafeInteger(line.quantity) &&
        line.quantity >= 0 &&
        line.quantity <= 999999 &&
        data?.lines.some(
          (item) =>
            item.lineItemId === line.lineItemId &&
            item.quantity !== line.quantity,
        ),
    );
  const run =
    selected ??
    data?.updates.find((item) =>
      [
        'preview',
        'approved',
        'approval_required',
        'uncertain',
        'unavailable',
      ].includes(item.state),
    ) ??
    null;
  const mutation = useMutation({
    mutationFn: async (command: {
      name: 'preview' | 'execute' | 'approve' | 'check';
      outcome?: 'approved' | 'rejected';
    }) => {
      if (command.name === 'preview') requestId.current ??= crypto.randomUUID();
      const input =
        command.name === 'preview'
          ? {
              connectionId,
              orderId,
              requestId: requestId.current,
              lines: planned,
            }
          : {
              id: run?.id,
              ...(command.outcome ? { outcome: command.outcome } : {}),
            };

      return updateSchema.parse(
        await services.request(`order-update-${command.name}`, input),
      );
    },
    onSuccess: (value) => {
      setSelected(value);
      void queryClient.invalidateQueries({ queryKey });
      if (value.state === 'verified')
        void queryClient.invalidateQueries({
          queryKey: ['private', 'organization', organizationId, 'order'],
        });
    },
  });
  const pending = mutation.isPending;
  const failure = mutation.error ?? inspection.error;

  return (
    <section
      className="connection-setup-form"
      aria-busy={pending || inspection.isLoading}
    >
      <h3>{m.starshipit_update_title()}</h3>
      <p className="field-help">{m.starshipit_update_help()}</p>
      {inspection.isLoading ? (
        <p role="status">{m.starshipit_update_loading()}</p>
      ) : null}
      {pending ? <p role="status">{m.starshipit_update_processing()}</p> : null}
      {data && !data.enabled ? (
        <p>{m.starshipit_update_unavailable()}</p>
      ) : null}
      {data?.enabled && !valid && !run ? (
        <p>{m.starshipit_update_no_plan()}</p>
      ) : null}
      {data?.enabled && valid && !run ? (
        <>
          <ul>
            {planned.map((line) => {
              const item = data.lines.find(
                (value) => value.lineItemId === line.lineItemId,
              );

              return (
                <li key={line.lineItemId}>
                  {item?.title ?? item?.sku ?? line.lineItemId}:{' '}
                  {m.starshipit_update_quantity({
                    before: formatNumber(item?.quantity ?? 0),
                    after: formatNumber(line.quantity),
                  })}
                </li>
              );
            })}
          </ul>
          <Button
            disabled={pending}
            onClick={() => mutation.mutate({ name: 'preview' })}
          >
            {m.starshipit_update_review()}
          </Button>
        </>
      ) : null}
      {run ? (
        <>
          <p role="status">
            {run.observeOnly
              ? m.starshipit_update_not_executed()
              : messages[run.state]()}
          </p>
          <ul>
            {run.lines.map((line) => (
              <li key={line.lineItemId}>
                {data?.lines.find((item) => item.lineItemId === line.lineItemId)
                  ?.title ?? line.lineItemId}
                :{' '}
                {m.starshipit_update_quantity({
                  before: formatNumber(line.currentQuantity),
                  after: formatNumber(line.quantity),
                })}
              </li>
            ))}
          </ul>
          <div className="form-actions">
            {run.canApprove ? (
              <>
                <Button
                  disabled={pending}
                  onClick={() =>
                    mutation.mutate({ name: 'approve', outcome: 'approved' })
                  }
                >
                  {m.starshipit_update_approve()}
                </Button>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    mutation.mutate({ name: 'approve', outcome: 'rejected' })
                  }
                >
                  {m.starshipit_update_reject()}
                </Button>
              </>
            ) : null}
            {run.canExecute ? (
              <Button
                disabled={pending}
                onClick={() => mutation.mutate({ name: 'execute' })}
              >
                {m.starshipit_update_send()}
              </Button>
            ) : null}
            {!['denied', 'verified', 'not_executed'].includes(run.state) ? (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => mutation.mutate({ name: 'check' })}
              >
                {m.starshipit_update_check()}
              </Button>
            ) : data?.enabled && valid ? (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() => {
                  requestId.current = null;
                  setSelected(null);
                  mutation.reset();
                }}
              >
                {m.starshipit_update_review()}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      <p role="alert">{failure ? services.error(failure) : ''}</p>
    </section>
  );
}
