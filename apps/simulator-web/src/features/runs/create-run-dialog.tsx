import { createRunSchema } from '@luma/simulator-contract';
import { chaosPresets } from '@luma/simulator-core';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@luma/ui/components/primitives/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Switch } from '@luma/ui/components/primitives/switch';
import { Plus } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';

import { errorMessage } from '../../api';
import { NumberField, SelectField } from '../../components/fields';
import { Loading } from '../../components/query-state';
import { formatCount } from '../../lib/format';
import { useCreateRun, useProfiles } from '../../queries';

const presetLabels: Record<string, string> = {
  calm: 'Calm: no failures',
  realistic: 'Realistic: everyday failures',
  'bad-day': 'Bad day: frequent failures',
  'outage-drill': 'Outage drill: hourly outages',
};

/** Labels a chaos preset name. */
export const presetLabel = (name: string) =>
  presetLabels[name] ??
  (name === 'custom' ? 'Custom profile' : name.replaceAll('-', ' '));

function suggestId(existing: readonly string[]) {
  let index = existing.length + 1;
  while (existing.includes(`merchant-${index}`)) index++;

  return `merchant-${index}`;
}

const erpLabels = { jtl: 'JTL-Wawi', cin7: 'Cin7 Core' } as const;

/**
 * Creates a run from a merchant profile and chaos preset. The new run provisions in the
 * background; `onCreated` receives its ID so the caller can select it.
 */
export function CreateRunDialog({
  existing,
  onCreated,
}: {
  existing: readonly string[];
  onCreated: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus aria-hidden="true" />
        New run
      </DialogTrigger>
      <DialogContent className="sim-dialog-wide">
        <DialogHeader>
          <DialogTitle>Create a run</DialogTitle>
          <DialogDescription>
            The simulator generates the merchant’s catalog, stock and order
            history, then keeps trading in real time.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <CreateRunForm
            defaultId={suggestId(existing)}
            existing={existing}
            onCreated={(id) => {
              setOpen(false);
              onCreated(id);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateRunForm({
  defaultId,
  existing,
  onCreated,
}: {
  defaultId: string;
  existing: readonly string[];
  onCreated: (id: string) => void;
}) {
  const profiles = useProfiles();
  const create = useCreateRun();
  const formId = useId();
  const [id, setId] = useState(defaultId);
  const [seed, setSeed] = useState<number | undefined>(44);
  const [profile, setProfile] = useState('large');
  const [erp, setErp] = useState<'profile' | 'jtl' | 'cin7'>('profile');
  const [chaos, setChaos] = useState('realistic');
  const [running, setRunning] = useState(true);
  const [problems, setProblems] = useState<string[]>([]);
  const presets =
    profiles.data?.chaos.map((preset) => preset.name) ??
    Object.keys(chaosPresets);
  const merchants = profiles.data?.merchants ?? [];
  const chosenProfile = merchants.some((merchant) => merchant.name === profile)
    ? profile
    : (merchants[0]?.name ?? profile);
  const profileErp = merchants.find(
    (merchant) => merchant.name === chosenProfile,
  )?.erp;

  function submit(event: FormEvent) {
    event.preventDefault();
    const body = {
      id,
      seed,
      profile: chosenProfile,
      ...(erp === 'profile' ? {} : { erp }),
      chaos,
      running,
    };
    const parsed = createRunSchema.safeParse(body);
    const issues = parsed.success
      ? []
      : parsed.error.issues.map((issue) =>
          issue.path[0] === 'id'
            ? 'Run ID: use 1 to 64 lowercase letters, digits or hyphens.'
            : issue.path[0] === 'seed'
              ? 'Seed: enter a whole number from 0 to 4,294,967,295.'
              : `${issue.path.join('.')}: ${issue.message}`,
        );
    if (existing.includes(id))
      issues.push('Run ID: a run with this ID exists.');
    setProblems(issues);
    if (issues.length || !parsed.success) return;
    create.mutate(parsed.data, { onSuccess: (run) => onCreated(run.id) });
  }

  return (
    <form id={formId} className="sim-form" onSubmit={submit} noValidate>
      <div className="sim-form-row">
        <Field>
          <FieldLabel htmlFor={`${formId}-id`}>Run ID</FieldLabel>
          <Input
            id={`${formId}-id`}
            value={id}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setId(event.currentTarget.value)}
            aria-describedby={`${formId}-id-description`}
          />
          <FieldDescription id={`${formId}-id-description`}>
            Lowercase letters, digits and hyphens.
          </FieldDescription>
        </Field>
        <NumberField
          label="Seed"
          value={seed}
          min={0}
          max={4_294_967_295}
          description="The same seed reproduces the same world."
          onChange={setSeed}
        />
      </div>
      <fieldset className="sim-fieldset">
        <legend>Merchant profile</legend>
        {profiles.isPending ? (
          <Loading label="Loading merchant profiles" />
        ) : profiles.isError ? (
          <p className="sim-error-text" role="alert">
            Merchant profiles are unavailable: {errorMessage(profiles.error)}{' '}
            The run uses the {profile} profile.
          </p>
        ) : (
          <div className="sim-choices">
            {merchants.map((merchant) => (
              <label key={merchant.name} className="sim-choice">
                <input
                  type="radio"
                  name={`${formId}-profile`}
                  value={merchant.name}
                  checked={chosenProfile === merchant.name}
                  onChange={() => setProfile(merchant.name)}
                />
                <span className="sim-choice-body">
                  <strong>{merchant.label}</strong>
                  <span>{merchant.description}</span>
                  <span className="sim-choice-facts lu-numeric">
                    {erpLabels[merchant.erp]} ·{' '}
                    {formatCount(merchant.ordersPerDay)} orders a day ·{' '}
                    {merchant.wholesaleOrdersPerDay
                      ? `${formatCount(merchant.wholesaleOrdersPerDay)} wholesale orders a weekday · `
                      : ''}
                    {formatCount(merchant.variants)} variants · {merchant.shops}{' '}
                    {merchant.shops === 1 ? 'shop' : 'shops'} ·{' '}
                    {merchant.warehouses}{' '}
                    {merchant.warehouses === 1 ? 'warehouse' : 'warehouses'}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <SelectField
        label="ERP"
        value={erp}
        options={[
          {
            value: 'profile',
            label: profileErp
              ? `Profile’s ERP (${erpLabels[profileErp]})`
              : 'Profile’s ERP',
          },
          { value: 'jtl', label: erpLabels.jtl },
          { value: 'cin7', label: erpLabels.cin7 },
        ]}
        description="Another ERP runs the same merchant to test compatibility."
        onChange={setErp}
      />
      <SelectField
        label="Chaos preset"
        value={chaos}
        options={presets.map((name) => ({
          value: name,
          label: presetLabel(name),
        }))}
        description="Change failures at any time on the Chaos tab."
        onChange={setChaos}
      />
      <label className="sim-switch">
        <Switch
          aria-labelledby={`${formId}-running`}
          aria-describedby={`${formId}-running-hint`}
          checked={running}
          onCheckedChange={setRunning}
        />
        <span>
          <span id={`${formId}-running`}>Start running in real time</span>
          <span id={`${formId}-running-hint`} className="sim-muted">
            {' '}
            — otherwise the clock stays paused until you start it.
          </span>
        </span>
      </label>
      {problems.length > 0 || create.isError ? (
        <FieldError>
          {create.isError ? (
            errorMessage(create.error)
          ) : (
            <ul className="sim-list">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </FieldError>
      ) : null}
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create run'}
        </Button>
      </DialogFooter>
    </form>
  );
}
