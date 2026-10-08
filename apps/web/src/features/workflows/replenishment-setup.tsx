import type {
  ReplenishmentBatchResult,
  ReplenishmentPreview,
  ReplenishmentRuleInput,
  ReplenishmentSetup,
  WorkflowDetail,
} from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import { Select } from '@luma/ui/components/primitives/select';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Search, ShieldCheck } from 'lucide-react';
import { useDeferredValue, useState } from 'react';

import { IdentityError } from '../identity/data';
import {
  configureReplenishmentBatch,
  previewReplenishment,
  replenishmentOptions,
  workflowError,
} from './data';

/** The most positions one setup can cover; larger scopes need several reviewed batches. */
export const setupLimit = 25;

type Quantities = { minimum: string; target: string; approvalQuantity: string };

type Position = ReplenishmentSetup['positions'][number];

const keyOf = (p: { positionId: string; connectionId: string }) =>
  `${p.positionId}:${p.connectionId}`;

const whole = (value: string) =>
  value.trim() !== '' && Number.isSafeInteger(Number(value))
    ? Number(value)
    : NaN;

/** Whether quantities are whole numbers in range with a target above the minimum. */
function validQuantities(q: Quantities) {
  const [minimum, target, limit] = [
    whole(q.minimum),
    whole(q.target),
    whole(q.approvalQuantity),
  ];

  return (
    minimum >= 0 &&
    minimum <= 999999 &&
    target > minimum &&
    target <= 1000000 &&
    limit >= 0 &&
    limit <= 1000000
  );
}

const uncertainError = (error: unknown) =>
  !(error instanceof IdentityError) || error.status >= 500;

type SetupFlowProps = {
  organizationId: string;
  detail: WorkflowDetail;
  setup: ReplenishmentSetup;
  /** A stock position to preselect, including one outside the first choices page. */
  initial?: string | undefined;
  onLock(locked: boolean): void;
  done(changed: boolean): void;
};

/** Loads a contextual stock choice before opening the reviewed setup form. */
export function ReplenishmentSetupFlow(props: SetupFlowProps) {
  const initial = useQuery({
    ...replenishmentOptions(props.organizationId, {
      positionId: props.initial,
    }),
    enabled: !!props.initial,
  });
  if (props.initial && initial.error)
    return (
      <Alert tone="danger" role="alert">
        {workflowError(initial.error)}
        <Button variant="outline" onClick={() => void initial.refetch()}>
          Retry
        </Button>
      </Alert>
    );
  if (props.initial && !initial.data)
    return <p role="status">Loading the stock position…</p>;

  return (
    <ReplenishmentSetupForm
      {...props}
      initialPositions={initial.data?.positions}
    />
  );
}

/** Reviews up to 25 positions; selections and retry IDs survive browsing and search. */
function ReplenishmentSetupForm({
  organizationId,
  detail,
  setup,
  initial,
  initialPositions,
  onLock,
  done,
}: SetupFlowProps & { initialPositions?: Position[] | undefined }) {
  const covered = new Set(
    setup.rules.filter((rule) => rule.active).map((rule) => rule.positionId),
  );
  const preselected = (initialPositions ?? setup.positions).find(
    (p) => p.positionId === initial && !covered.has(p.positionId),
  );
  const [step, setStep] = useState<'choose' | 'review' | 'results'>('choose');
  const [supplierId, setSupplierId] = useState(
    setup.suppliers.length === 1 ? setup.suppliers[0]!.id : '',
  );
  const [selected, setSelected] = useState<Position[]>(
    preselected ? [preselected] : [],
  );
  const selectedKeys = selected.map(keyOf);
  const [filter, setFilter] = useState('');
  const search = useDeferredValue(filter.trim());
  const [cursors, setCursors] = useState<string[]>([]);
  const choices = useQuery({
    ...replenishmentOptions(organizationId, {
      q: search,
      cursor: cursors.at(-1),
    }),
    ...(!search && !cursors.length ? { initialData: setup } : {}),
  });
  const browsing = choices.isFetching || search !== filter.trim();
  const page = choices.data?.positions ?? [];

  const [defaults, setDefaults] = useState<Quantities>({
    minimum: '10',
    target: '50',
    approvalQuantity: '100',
  });
  const [overrides, setOverrides] = useState<Record<string, Quantities>>({});
  const [preview, setPreview] = useState<ReplenishmentPreview | null>(null);
  const [stale, setStale] = useState(false);
  const [submitted, setSubmitted] = useState<ReplenishmentRuleInput[]>([]);
  const [results, setResults] = useState<ReplenishmentBatchResult['results']>(
    [],
  );
  const positions = new Map([...page, ...selected].map((p) => [keyOf(p), p]));
  const quantities = (key: string) => overrides[key] ?? defaults;
  const previewing = useMutation({
    mutationFn: () =>
      previewReplenishment(organizationId, {
        supplierId,
        items: selectedKeys.map((key) => {
          const position = positions.get(key)!;
          const q = quantities(key);

          return {
            positionId: position.positionId,
            connectionId: position.connectionId,
            minimum: whole(q.minimum),
            target: whole(q.target),
            approvalQuantity: whole(q.approvalQuantity),
          };
        }),
      }),
    onSuccess: (result) => {
      setPreview(result);
      setStale(false);
      setStep('review');
    },
  });
  const activating = useMutation({
    mutationFn: (items: ReplenishmentRuleInput[]) =>
      configureReplenishmentBatch(organizationId, items),
    onMutate: () => onLock(true),
    onSuccess: (outcome) => {
      onLock(false);
      // Keep earlier answers for items that weren't part of this retry.
      setResults((previous) => [
        ...previous.filter(
          (item) => !outcome.some((next) => next.id === item.id),
        ),
        ...outcome,
      ]);
      setStep('results');
    },
    onError: (error) => onLock(uncertainError(error)),
  });

  const ready = preview?.items.filter((item) => item.outcome === 'ready') ?? [];
  const submit = (items: ReplenishmentRuleInput[]) => {
    setSubmitted(items);
    activating.mutate(items);
  };
  const activate = () => {
    if (!preview) return;
    const ids = new Map(submitted.map((item) => [item.positionId, item.id]));
    submit(
      ready.map((item) => {
        const q = quantities(keyOf(item));

        return {
          id: ids.get(item.positionId) ?? crypto.randomUUID(),
          positionId: item.positionId,
          connectionId: item.connectionId,
          supplierId: preview.supplier.id,
          minimum: whole(q.minimum),
          target: whole(q.target),
          approvalQuantity: whole(q.approvalQuantity),
          reviewedDigest: detail.versions[0]!.digest,
        };
      }),
    );
  };
  const failure = activating.error ?? previewing.error;

  if (step === 'results')
    return (
      <SetupResults
        organizationId={organizationId}
        results={results}
        submitted={submitted}
        positions={positions}
        retrying={activating.isPending}
        error={activating.error ? workflowError(activating.error) : ''}
        retry={(items) => activating.mutate(items)}
        done={() => done(results.some((r) => r.status !== 'failed'))}
      />
    );

  if (step === 'review' && preview)
    return (
      <div className="replenishment-setup">
        <div className="replenishment-approval">
          <ShieldCheck size={17} aria-hidden="true" />
          <div>
            <strong>{preview.approval.summary}</strong>
            <ul>
              {preview.approval.details.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
        <p className="replenishment-setup-note">
          Ordering from <strong>{preview.supplier.name}</strong>. Each rule
          covers exactly one stock position. Positions you didn’t select aren’t
          included.
        </p>
        <ul className="replenishment-targets" aria-label="Rules to activate">
          {preview.items.map((item) => {
            const key = keyOf(item);
            const q = quantities(key);
            const editable =
              item.outcome === 'ready' || item.outcome === 'invalid';
            const update = (field: keyof Quantities, value: string) => {
              setOverrides((all) => ({
                ...all,
                [key]: { ...quantities(key), [field]: value },
              }));
              setStale(true);
            };

            return (
              <li key={key} data-outcome={item.outcome}>
                <div className="replenishment-target-head">
                  <div>
                    <strong>{item.sku ?? 'Unknown SKU'}</strong>
                    <small>
                      {item.available ?? 'Unknown'} {item.unit ?? ''} available
                      {item.observedAt ? (
                        <>
                          {' · read '}
                          <WorkspaceDate value={item.observedAt} />
                        </>
                      ) : null}
                    </small>
                  </div>
                  <Badge
                    tone={
                      item.outcome === 'ready'
                        ? 'success'
                        : item.outcome === 'covered'
                          ? 'neutral'
                          : 'warning'
                    }
                  >
                    {item.outcome === 'ready'
                      ? 'Will activate'
                      : item.outcome === 'covered'
                        ? 'Already covered'
                        : item.outcome === 'invalid'
                          ? 'Check quantities'
                          : 'Unavailable'}
                  </Badge>
                </div>
                {editable ? (
                  <div className="replenishment-target-quantities">
                    <label>
                      Minimum
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        aria-label={`Minimum stock for ${item.sku}`}
                        value={q.minimum}
                        disabled={activating.isPending}
                        onChange={(e) => update('minimum', e.target.value)}
                      />
                    </label>
                    <label>
                      Target
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        aria-label={`Target stock for ${item.sku}`}
                        value={q.target}
                        disabled={activating.isPending}
                        onChange={(e) => update('target', e.target.value)}
                      />
                    </label>
                    <label>
                      High risk above
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        aria-label={`High-risk quantity for ${item.sku}`}
                        value={q.approvalQuantity}
                        disabled={activating.isPending}
                        onChange={(e) =>
                          update('approvalQuantity', e.target.value)
                        }
                      />
                    </label>
                  </div>
                ) : null}
                <p>
                  {stale && editable
                    ? 'Quantities changed. Update the preview to check them.'
                    : item.message}
                </p>
                {!stale && item.risk ? (
                  <p className="replenishment-target-proposal">
                    {item.risk === 'high' ? 'High risk' : 'Medium risk'} · needs
                    approval
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="replenishment-setup-note" aria-live="polite">
          {stale
            ? 'Update the preview before activating.'
            : `${ready.length} ${ready.length === 1 ? 'rule' : 'rules'} will activate. ${preview.items.length - ready.length} ${preview.items.length - ready.length === 1 ? 'position stays' : 'positions stay'} unchanged.`}
        </p>
        {failure ? (
          <Alert tone="danger" role="alert">
            {uncertainError(failure) && activating.error
              ? 'Luma couldn’t confirm the activations. Retry; the same requests never create a second rule.'
              : workflowError(failure)}
          </Alert>
        ) : null}
        <div className="workflow-dialog-actions">
          <Button
            variant="outline"
            disabled={
              activating.isPending ||
              (!!activating.error && uncertainError(activating.error))
            }
            onClick={() => {
              // Nothing was saved unless a response was uncertain, so new IDs are safe.
              setSubmitted([]);
              activating.reset();
              setStep('choose');
            }}
          >
            Back
          </Button>
          {stale ? (
            <Button
              disabled={
                previewing.isPending ||
                !selectedKeys.every((key) => validQuantities(quantities(key)))
              }
              onClick={() => previewing.mutate()}
            >
              {previewing.isPending ? 'Checking…' : 'Update preview'}
            </Button>
          ) : activating.error && uncertainError(activating.error) ? (
            <Button
              disabled={activating.isPending}
              onClick={() => activating.mutate(submitted)}
            >
              Retry activation
            </Button>
          ) : (
            <Button
              disabled={!ready.length || activating.isPending}
              onClick={activate}
            >
              {activating.isPending
                ? 'Activating…'
                : `Activate ${ready.length} ${ready.length === 1 ? 'rule' : 'rules'}`}
            </Button>
          )}
        </div>
      </div>
    );

  const visible = [
    ...selected,
    ...page.filter((p) => !selectedKeys.includes(keyOf(p))),
  ];
  const canPreview =
    !!supplierId &&
    selected.length > 0 &&
    selectedKeys.every((key) => validQuantities(quantities(key)));

  return (
    <form
      className="replenishment-setup"
      onSubmit={(event) => {
        event.preventDefault();
        if (canPreview) previewing.mutate();
      }}
    >
      {!setup.suppliers.length ? (
        <Alert tone="warning">
          Add the supplier you reorder from first.{' '}
          <Link
            to="/app/$organizationId/procurement"
            params={{ organizationId }}
            search={{ view: 'suppliers', q: '', status: '' }}
          >
            Add a supplier in Procurement <ArrowRight size={13} />
          </Link>
        </Alert>
      ) : (
        <label>
          Supplier
          <Select
            aria-label="Supplier"
            value={supplierId}
            onValueChange={(value) => setSupplierId(value ?? '')}
            placeholder="Choose supplier"
            options={setup.suppliers.map((s) => ({
              value: s.id,
              label: s.name,
            }))}
          />
        </label>
      )}
      <fieldset className="replenishment-setup-positions">
        <legend>Stock positions</legend>
        <div className="replenishment-filter">
          <Search size={15} aria-hidden="true" />
          <Input
            type="search"
            aria-label="Filter stock positions"
            placeholder="Filter by SKU"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setCursors([]);
            }}
          />
        </div>
        <p className="replenishment-setup-note" aria-live="polite">
          {selected.length} of {setupLimit} selected
          {selected.length >= setupLimit
            ? '. Set up more positions in another batch.'
            : ''}
        </p>
        {browsing ? (
          <p role="status">Loading stock positions…</p>
        ) : choices.error ? (
          <Alert tone="danger" role="alert">
            {workflowError(choices.error)}
            <Button
              type="button"
              variant="outline"
              onClick={() => void choices.refetch()}
            >
              Retry
            </Button>
          </Alert>
        ) : !page.length ? (
          <p className="replenishment-setup-note">
            {search
              ? `No SKU matches “${search}”.`
              : 'No stock positions on this page. Connect an inventory source if none have been imported.'}
          </p>
        ) : null}
        <div className="replenishment-position-list">
          {visible.map((position) => (
            <PositionOption
              key={keyOf(position)}
              position={position}
              checked={selectedKeys.includes(keyOf(position))}
              covered={covered.has(position.positionId)}
              otherSource={selectedKeys.some(
                (key) =>
                  key !== keyOf(position) &&
                  positions.get(key)?.positionId === position.positionId,
              )}
              full={selected.length >= setupLimit}
              loading={browsing && !selectedKeys.includes(keyOf(position))}
              showSource
              toggle={(checked) =>
                setSelected((keys) =>
                  checked
                    ? [...keys, position]
                    : keys.filter((p) => keyOf(p) !== keyOf(position)),
                )
              }
            />
          ))}
        </div>
        <Pagination
          count={page.length}
          page={cursors.length + 1}
          pageSize={50}
          itemLabel="stock choices"
          label="Stock position pages"
          hasNext={!!choices.data?.nextCursor}
          disabled={browsing || !!choices.error}
          onPrevious={
            cursors.length
              ? () => setCursors((all) => all.slice(0, -1))
              : undefined
          }
          onNext={() => {
            const next = choices.data?.nextCursor;
            if (next) setCursors((all) => [...all, next]);
          }}
        />
      </fieldset>
      <fieldset className="replenishment-setup-defaults">
        <legend>Quantities</legend>
        <div className="replenishment-form-pair">
          <label>
            Minimum stock
            <Input
              type="number"
              min="0"
              max="999999"
              step="1"
              required
              value={defaults.minimum}
              onChange={(e) =>
                setDefaults((q) => ({ ...q, minimum: e.target.value }))
              }
            />
          </label>
          <label>
            Target stock
            <Input
              type="number"
              min="1"
              max="1000000"
              step="1"
              required
              value={defaults.target}
              onChange={(e) =>
                setDefaults((q) => ({ ...q, target: e.target.value }))
              }
            />
          </label>
        </div>
        <label>
          High-risk quantity threshold
          <Input
            type="number"
            min="0"
            max="1000000"
            step="1"
            required
            value={defaults.approvalQuantity}
            onChange={(e) =>
              setDefaults((q) => ({ ...q, approvalQuantity: e.target.value }))
            }
          />
        </label>
        <p className="replenishment-setup-note">
          When stock falls below the minimum, Luma proposes enough to reach the
          target. Drafts above the threshold are high risk. Every draft still
          needs approval. You can adjust each position on the next step.
        </p>
      </fieldset>
      {previewing.error ? (
        <Alert tone="danger" role="alert">
          {workflowError(previewing.error)}
        </Alert>
      ) : null}
      {selected.length && !validQuantities(defaults) ? (
        <p className="replenishment-setup-note" role="status">
          Use whole quantities, with target stock above the minimum.
        </p>
      ) : null}
      <div className="workflow-dialog-actions">
        <Button type="button" variant="outline" onClick={() => done(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canPreview || previewing.isPending}>
          {previewing.isPending
            ? 'Checking…'
            : `Preview ${selected.length || ''} ${selected.length === 1 ? 'rule' : 'rules'}`}
        </Button>
      </div>
    </form>
  );
}

function PositionOption({
  position,
  checked,
  covered,
  otherSource,
  full,
  loading,
  showSource,
  toggle,
}: {
  position: Position;
  checked: boolean;
  covered: boolean;
  /** Another source of the same position is selected; a rule covers a position once. */
  otherSource: boolean;
  full: boolean;
  loading: boolean;
  showSource: boolean;
  toggle(checked: boolean): void;
}) {
  return (
    <label data-covered={covered || undefined}>
      <input
        type="checkbox"
        checked={checked}
        disabled={loading || covered || otherSource || (full && !checked)}
        onChange={(e) => toggle(e.target.checked)}
      />
      <span>
        <strong>{position.sku}</strong>
        <small>
          {position.available ?? 'Unknown'} {position.unit} available
          {showSource ? ` · source ${position.connectionId.slice(0, 8)}` : ''}
          {covered ? ' · already has an active rule' : ''}
          {otherSource ? ' · another source is selected' : ''}
        </small>
      </span>
    </label>
  );
}

function SetupResults({
  organizationId,
  results,
  submitted,
  positions,
  retrying,
  error,
  retry,
  done,
}: {
  organizationId: string;
  results: ReplenishmentBatchResult['results'];
  submitted: ReplenishmentRuleInput[];
  positions: Map<string, Position>;
  retrying: boolean;
  error: string;
  retry(items: ReplenishmentRuleInput[]): void;
  done(): void;
}) {
  const sku = (positionId: string) =>
    [...positions.values()].find((p) => p.positionId === positionId)?.sku ??
    positionId;
  const uncertain = submitted.filter((item) =>
    results.some((r) => r.id === item.id && r.status === 'uncertain'),
  );
  const count = (status: string) =>
    results.filter((r) => r.status === status).length;

  return (
    <div className="replenishment-setup">
      <p className="replenishment-setup-note" role="status">
        {count('activated')} activated
        {count('failed') ? ` · ${count('failed')} not activated` : ''}
        {count('uncertain') ? ` · ${count('uncertain')} unconfirmed` : ''}
      </p>
      <ul className="replenishment-targets" aria-label="Activation results">
        {results.map((result) => (
          <li key={result.id} data-outcome={result.status}>
            <div className="replenishment-target-head">
              <strong>{sku(result.positionId)}</strong>
              <StatePill
                state={
                  result.status === 'activated'
                    ? 'running'
                    : result.status === 'uncertain'
                      ? 'error'
                      : 'attention'
                }
              >
                {result.status === 'activated'
                  ? 'Activated'
                  : result.status === 'uncertain'
                    ? 'Unconfirmed'
                    : result.code === 'covered'
                      ? 'Already covered'
                      : 'Not activated'}
              </StatePill>
            </div>
            <p>{result.message}</p>
            {result.status === 'activated' ? (
              <Link
                className="workflow-repair-link"
                to="/app/$organizationId/inventory/$positionId"
                params={{ organizationId, positionId: result.positionId }}
              >
                Stock record <ArrowRight size={13} aria-hidden="true" />
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? (
        <Alert tone="danger" role="alert">
          {error}
        </Alert>
      ) : null}
      <div className="workflow-dialog-actions">
        {uncertain.length ? (
          <Button
            variant="outline"
            disabled={retrying}
            onClick={() => retry(uncertain)}
          >
            {retrying ? 'Retrying…' : `Retry ${uncertain.length} unconfirmed`}
          </Button>
        ) : null}
        <Button disabled={retrying} onClick={done}>
          Done
        </Button>
      </div>
    </div>
  );
}
