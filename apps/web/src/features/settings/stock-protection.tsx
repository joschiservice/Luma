import {
  type StockProtectionSettings,
  stockProtectionSettingsSchema,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { ApiError } from '../../lib/api-error';
import {
  stockProtectionApi,
  stockProtectionOptions,
} from '../../shared/stock-protection/data';
import { StockProtectionNotice } from '../../shared/stock-protection/notice';

const numbers = {
  riskThreshold: m.settings_protection_risk,
  bufferUnits: m.settings_protection_buffer_units,
  bufferPercent: m.settings_protection_buffer_percent,
  keepSellable: m.settings_protection_keep_sellable,
  maxSkus: m.settings_protection_max_skus,
  maxUnitsPerSku: m.settings_protection_max_units,
  dailyUnits: m.settings_protection_daily_units,
  maxDurationSeconds: m.settings_protection_duration,
};

/** Edits explicit, versioned per-store consent; active holds require a chosen disposition. */
export function StockProtectionSettings({
  organizationId,
  disabled,
}: {
  organizationId: string;
  disabled: boolean;
}) {
  const query = useQuery(stockProtectionOptions(organizationId));
  if (
    query.error instanceof ApiError &&
    [401, 403, 404].includes(query.error.status)
  )
    return null;
  if (query.isError && !query.data)
    return (
      <section>
        <h2>{m.settings_protection_title()}</h2>
        <Alert role="alert" tone="warning">
          {m.settings_protection_settings_unavailable()}
        </Alert>
      </section>
    );
  if (!query.data?.enabled) return null;

  return (
    <section>
      <h2>{m.settings_protection_title()}</h2>
      <p>{m.settings_protection_help()}</p>
      {query.isError ? (
        <Alert role="alert" tone="warning">
          {m.settings_protection_settings_unavailable()}
        </Alert>
      ) : null}
      {query.data.pairs.length ? (
        query.data.pairs.map((pair) => {
          const settings =
            query.data.settings.find(
              (s) =>
                s.connectionId === pair.connectionId &&
                s.sourceConnectionId === pair.sourceConnectionId,
            ) ??
            stockProtectionSettingsSchema.parse({
              connectionId: pair.connectionId,
              sourceConnectionId: pair.sourceConnectionId,
            });
          const active = query.data.incidents.some(
            (i) =>
              i.connectionId === pair.connectionId &&
              i.state !== 'released' &&
              (i.heldCount ?? 0) +
                (i.pendingCount ?? 0) +
                (i.uncertainCount ?? 0) >
                0,
          );

          return (
            <ProtectionForm
              key={`${pair.connectionId}:${settings.revision}`}
              organizationId={organizationId}
              label={pair.label}
              settings={settings}
              active={active}
              disabled={disabled || query.isError || !query.data.canManage}
              saved={() => query.refetch().then(() => undefined)}
            />
          );
        })
      ) : (
        <p>{m.settings_protection_no_pairs()}</p>
      )}
      <StockProtectionNotice organizationId={organizationId} />
    </section>
  );
}

function ProtectionForm({
  organizationId,
  label,
  settings,
  active,
  disabled,
  saved,
}: {
  organizationId: string;
  label: string;
  settings: StockProtectionSettings;
  active: boolean;
  disabled: boolean;
  saved(): Promise<void>;
}) {
  const id = useId();
  const [value, setValue] = useState(settings);
  const [exclusions, setExclusions] = useState({
    skus: settings.exclusions.skus.join(', '),
    tags: settings.exclusions.tags.join(', '),
    collections: settings.exclusions.collections.join(', '),
  });
  const [disposition, setDisposition] = useState<'release' | 'keep' | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h3">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          aria-label={label}
          aria-busy={pending}
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            const parsed = stockProtectionSettingsSchema.safeParse({
              ...value,
              exclusions: {
                skus: exclusions.skus
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
                tags: exclusions.tags
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
                collections: exclusions.collections
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              },
            });
            if (!parsed.success) {
              setMessage(m.settings_protection_invalid());

              return;
            }
            setPending(true);
            setMessage('');
            stockProtectionApi
              .save({
                params: { organizationId },
                body: {
                  settings: parsed.data,
                  ...(disposition ? { activeHolds: disposition } : {}),
                },
              })
              .then(saved)
              .catch(() =>
                setMessage(m.settings_protection_change_unconfirmed()),
              )
              .finally(() => setPending(false));
          }}
        >
          <fieldset disabled={disabled || pending}>
            <label htmlFor={`${id}-mode`}>{m.settings_protection_mode()}</label>
            <Select
              id={`${id}-mode`}
              value={value.mode}
              onValueChange={(mode) => {
                if (mode) setValue((v) => ({ ...v, mode }));
              }}
              options={[
                { value: 'off', label: m.settings_protection_off() },
                { value: 'preview', label: m.settings_protection_preview() },
                { value: 'on', label: m.settings_protection_on() },
              ]}
            />
            {Object.entries(numbers).map(([key, label]) => {
              const field = key as keyof typeof numbers;

              return (
                <div className="form-field" key={field}>
                  <label htmlFor={`${id}-${field}`}>{label()}</label>
                  <Input
                    id={`${id}-${field}`}
                    type="number"
                    min={
                      field === 'maxSkus' ||
                      field === 'maxUnitsPerSku' ||
                      field === 'dailyUnits'
                        ? 1
                        : field === 'maxDurationSeconds'
                          ? 60
                          : 0
                    }
                    max={field === 'bufferPercent' ? 100 : undefined}
                    required
                    value={value[field]}
                    onChange={(event) =>
                      setValue((v) => ({
                        ...v,
                        [field]: event.target.valueAsNumber,
                      }))
                    }
                  />
                </div>
              );
            })}
            <label>
              <input
                type="checkbox"
                checked={value.includeSalesRate}
                onChange={(event) =>
                  setValue((v) => ({
                    ...v,
                    includeSalesRate: event.target.checked,
                  }))
                }
              />{' '}
              {m.settings_protection_sales_rate()}
            </label>
            {(['skus', 'tags', 'collections'] as const).map((field) => (
              <div className="form-field" key={field}>
                <label htmlFor={`${id}-${field}`}>
                  {field === 'skus'
                    ? m.settings_protection_exclude_skus()
                    : field === 'tags'
                      ? m.settings_protection_exclude_tags()
                      : m.settings_protection_exclude_collections()}
                </label>
                <Input
                  id={`${id}-${field}`}
                  value={exclusions[field]}
                  onChange={(event) =>
                    setExclusions((previous) => ({
                      ...previous,
                      [field]: event.target.value,
                    }))
                  }
                />
              </div>
            ))}
            <label htmlFor={`${id}-duration-action`}>
              {m.settings_protection_duration_action()}
            </label>
            <Select
              id={`${id}-duration-action`}
              value={value.durationAction}
              onValueChange={(durationAction) => {
                if (durationAction) setValue((v) => ({ ...v, durationAction }));
              }}
              options={[
                {
                  value: 'escalate',
                  label: m.settings_protection_keep_escalate(),
                },
                {
                  value: 'release',
                  label: m.settings_protection_release_at_limit(),
                },
              ]}
            />
            <p>
              {m.settings_protection_example({
                before: formatNumber(10),
                after: formatNumber(
                  Math.min(
                    10,
                    Math.max(
                      value.keepSellable,
                      10 -
                        Math.max(
                          value.bufferUnits,
                          Math.ceil((10 * value.bufferPercent) / 100),
                        ),
                    ),
                  ),
                ),
              })}
            </p>
            {active && value.mode !== 'on' ? (
              <Alert tone="warning">
                <p>{m.settings_protection_disable_help()}</p>
                <Select
                  aria-label={m.settings_protection_disposition()}
                  value={disposition}
                  onValueChange={setDisposition}
                  options={[
                    {
                      value: 'release',
                      label: m.settings_protection_release_all(),
                    },
                    { value: 'keep', label: m.settings_protection_keep() },
                  ]}
                />
              </Alert>
            ) : null}
            <Button
              type="submit"
              disabled={active && value.mode !== 'on' && !disposition}
            >
              {pending ? m.common_saving() : m.settings_protection_save()}
            </Button>
          </fieldset>
          {message ? <p role="alert">{message}</p> : null}
        </form>
      </CardContent>
    </Card>
  );
}
