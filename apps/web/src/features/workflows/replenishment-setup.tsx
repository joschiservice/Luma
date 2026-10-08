import type {
  ReplenishmentBatchResult,
  ReplenishmentPreview,
  ReplenishmentRuleInput,
  ReplenishmentSetup,
  WorkflowDetail,
} from '@luma/api-contract';
import { formatNumber } from '@luma/i18n/format';
import { m } from '@luma/i18n/messages';
import { rich } from '@luma/i18n/rich';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { StatePill } from '@luma/ui/components/primitives/state';
import { WorkspaceDate } from '@luma/ui/components/primitives/workspace-date';
import { quantityUnit } from '@luma/ui/lib/units';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Search, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { IdentityError } from '../identity/data';
import {
  configureReplenishmentBatch,
  previewReplenishment,
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

const availableLabel = (available: number | null) =>
  available === null ? m.common_unknown() : formatNumber(available);

const previewOutcomes = {
  ready: m.workflows_setup_outcome_ready,
  covered: m.workflows_setup_outcome_covered,
  invalid: m.workflows_setup_outcome_invalid,
  unavailable: m.workflows_setup_outcome_unavailable,
} satisfies Record<
  ReplenishmentPreview['items'][number]['outcome'],
  () => string
>;

const uncertainError = (error: unknown) =>
  !(error instanceof IdentityError) || error.status >= 500;

/**
 * Sets up stock rules for up to 25 positions in three steps: choose positions and a supplier,
 * review what each rule would do, then see each result. Each rule covers exactly one position, an
 * existing rule is never replaced, and a retry resends the same request IDs.
 */
export function ReplenishmentSetupFlow({
  organizationId,
  detail,
  setup,
  initial,
  onLock,
  done,
}: {
  organizationId: string;
  detail: WorkflowDetail;
  setup: ReplenishmentSetup;
  /** A stock position to preselect. */
  initial?: string | undefined;
  onLock(locked: boolean): void;
  done(changed: boolean): void;
}) {
  const covered = new Set(
    setup.rules.filter((rule) => rule.active).map((rule) => rule.positionId),
  );
  const preselected = setup.positions.find(
    (p) => p.positionId === initial && !covered.has(p.positionId),
  );
  const [step, setStep] = useState<'choose' | 'review' | 'results'>('choose');
  const [supplierId, setSupplierId] = useState(
    setup.suppliers.length === 1 ? setup.suppliers[0]!.id : '',
  );
  const [selected, setSelected] = useState<string[]>(
    preselected ? [keyOf(preselected)] : [],
  );
  const [filter, setFilter] = useState('');
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
  const positions = new Map(setup.positions.map((p) => [keyOf(p), p]));
  const quantities = (key: string) => overrides[key] ?? defaults;
  const skuCounts = new Map<string, number>();
  for (const p of setup.positions)
    skuCounts.set(p.sku, (skuCounts.get(p.sku) ?? 0) + 1);

  const previewing = useMutation({
    mutationFn: () =>
      previewReplenishment(organizationId, {
        supplierId,
        items: selected.map((key) => {
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
          {rich(m.workflows_setup_ordering_from, {
            supplier: <strong>{preview.supplier.name}</strong>,
          })}
        </p>
        <ul
          className="replenishment-targets"
          aria-label={m.workflows_setup_targets_label()}
        >
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
                    <strong>
                      {item.sku ?? m.workflows_setup_unknown_sku()}
                    </strong>
                    <small>
                      {item.observedAt
                        ? rich(m.workflows_setup_available_read, {
                            available: availableLabel(item.available),
                            unit: quantityUnit(
                              item.unit ?? '',
                              item.available ?? '',
                            ),
                            date: <WorkspaceDate value={item.observedAt} />,
                          })
                        : m.workflows_setup_available({
                            available: availableLabel(item.available),
                            unit: quantityUnit(
                              item.unit ?? '',
                              item.available ?? '',
                            ),
                          })}
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
                    {previewOutcomes[item.outcome]()}
                  </Badge>
                </div>
                {editable ? (
                  <div className="replenishment-target-quantities">
                    <label>
                      {m.workflows_setup_minimum()}
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        aria-label={m.workflows_setup_minimum_for({
                          sku: item.sku ?? m.workflows_setup_unknown_sku(),
                        })}
                        value={q.minimum}
                        disabled={activating.isPending}
                        onChange={(e) => update('minimum', e.target.value)}
                      />
                    </label>
                    <label>
                      {m.workflows_setup_target()}
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        aria-label={m.workflows_setup_target_for({
                          sku: item.sku ?? m.workflows_setup_unknown_sku(),
                        })}
                        value={q.target}
                        disabled={activating.isPending}
                        onChange={(e) => update('target', e.target.value)}
                      />
                    </label>
                    <label>
                      {m.workflows_setup_high_risk()}
                      <Input
                        type="number"
                        min="0"
                        step="1"
                        aria-label={m.workflows_setup_high_risk_for({
                          sku: item.sku ?? m.workflows_setup_unknown_sku(),
                        })}
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
                    ? m.workflows_setup_quantities_changed()
                    : item.message}
                </p>
                {!stale && item.risk ? (
                  <p className="replenishment-target-proposal">
                    {item.risk === 'high'
                      ? m.workflows_setup_high_risk_note()
                      : m.workflows_setup_medium_risk_note()}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="replenishment-setup-note" aria-live="polite">
          {stale
            ? m.workflows_setup_update_first()
            : m.workflows_setup_review_summary({
                ready: ready.length,
                unchanged: preview.items.length - ready.length,
              })}
        </p>
        {failure ? (
          <Alert tone="danger" role="alert">
            {uncertainError(failure) && activating.error
              ? m.workflows_setup_unconfirmed()
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
            {m.common_back()}
          </Button>
          {stale ? (
            <Button
              disabled={
                previewing.isPending ||
                !selected.every((key) => validQuantities(quantities(key)))
              }
              onClick={() => previewing.mutate()}
            >
              {previewing.isPending
                ? m.workflows_setup_checking()
                : m.workflows_setup_update_preview()}
            </Button>
          ) : activating.error && uncertainError(activating.error) ? (
            <Button
              disabled={activating.isPending}
              onClick={() => activating.mutate(submitted)}
            >
              {m.workflows_setup_retry_activation()}
            </Button>
          ) : (
            <Button
              disabled={!ready.length || activating.isPending}
              onClick={activate}
            >
              {activating.isPending
                ? m.workflows_setup_activating()
                : m.workflows_setup_activate({ count: ready.length })}
            </Button>
          )}
        </div>
      </div>
    );

  const visible = setup.positions.filter((p) =>
    p.sku.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const canPreview =
    !!supplierId &&
    selected.length > 0 &&
    selected.every((key) => validQuantities(quantities(key)));

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
          {m.workflows_setup_add_supplier_first()}{' '}
          <Link
            to="/app/$organizationId/procurement"
            params={{ organizationId }}
            search={{ view: 'suppliers', q: '', status: '' }}
          >
            {m.workflows_rules_add_supplier()} <ArrowRight size={13} />
          </Link>
        </Alert>
      ) : (
        <label>
          {m.workflows_setup_supplier()}
          <Select
            aria-label={m.workflows_setup_supplier()}
            value={supplierId}
            onValueChange={(value) => setSupplierId(value ?? '')}
            placeholder={m.workflows_setup_supplier_placeholder()}
            options={setup.suppliers.map((s) => ({
              value: s.id,
              label: s.name,
            }))}
          />
        </label>
      )}
      <fieldset className="replenishment-setup-positions">
        <legend>{m.workflows_setup_positions()}</legend>
        <div className="replenishment-filter">
          <Search size={15} aria-hidden="true" />
          <Input
            type="search"
            aria-label={m.workflows_setup_filter_label()}
            placeholder={m.workflows_setup_filter_placeholder()}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <p className="replenishment-setup-note" aria-live="polite">
          {selected.length >= setupLimit
            ? m.workflows_setup_selected_full({
                selected: selected.length,
                limit: setupLimit,
              })
            : m.workflows_setup_selected({
                selected: selected.length,
                limit: setupLimit,
              })}
        </p>
        {!setup.positions.length ? (
          <p className="replenishment-setup-note">
            {m.workflows_setup_no_positions()}
          </p>
        ) : !visible.length ? (
          <p className="replenishment-setup-note">
            {m.workflows_setup_no_match({ filter })}
          </p>
        ) : null}
        <div className="replenishment-position-list">
          {visible.map((position) => (
            <PositionOption
              key={keyOf(position)}
              position={position}
              checked={selected.includes(keyOf(position))}
              covered={covered.has(position.positionId)}
              otherSource={selected.some(
                (key) =>
                  key !== keyOf(position) &&
                  positions.get(key)?.positionId === position.positionId,
              )}
              full={selected.length >= setupLimit}
              showSource={(skuCounts.get(position.sku) ?? 0) > 1}
              toggle={(checked) =>
                setSelected((keys) =>
                  checked
                    ? [...keys, keyOf(position)]
                    : keys.filter((key) => key !== keyOf(position)),
                )
              }
            />
          ))}
        </div>
      </fieldset>
      <fieldset className="replenishment-setup-defaults">
        <legend>{m.workflows_setup_quantities()}</legend>
        <div className="replenishment-form-pair">
          <label>
            {m.workflows_setup_minimum_stock()}
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
            {m.workflows_setup_target_stock()}
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
          {m.workflows_setup_high_risk_threshold()}
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
          {m.workflows_setup_quantities_help()}
        </p>
      </fieldset>
      {previewing.error ? (
        <Alert tone="danger" role="alert">
          {workflowError(previewing.error)}
        </Alert>
      ) : null}
      {selected.length && !validQuantities(defaults) ? (
        <p className="replenishment-setup-note" role="status">
          {m.workflows_setup_whole_numbers()}
        </p>
      ) : null}
      <div className="workflow-dialog-actions">
        <Button type="button" variant="outline" onClick={() => done(false)}>
          {m.common_cancel()}
        </Button>
        <Button type="submit" disabled={!canPreview || previewing.isPending}>
          {previewing.isPending
            ? m.workflows_setup_checking()
            : selected.length
              ? m.workflows_setup_preview({ count: selected.length })
              : m.workflows_setup_preview_none()}
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
  showSource,
  toggle,
}: {
  position: Position;
  checked: boolean;
  covered: boolean;
  /** Another source of the same position is selected; a rule covers a position once. */
  otherSource: boolean;
  full: boolean;
  showSource: boolean;
  toggle(checked: boolean): void;
}) {
  return (
    <label data-covered={covered || undefined}>
      <input
        type="checkbox"
        checked={checked}
        disabled={covered || otherSource || (full && !checked)}
        onChange={(e) => toggle(e.target.checked)}
      />
      <span>
        <strong>{position.sku}</strong>
        <small>
          {[
            m.workflows_setup_available({
              available: availableLabel(position.available),
              unit: quantityUnit(position.unit, position.available ?? ''),
            }),
            ...(showSource
              ? [
                  m.workflows_setup_position_source({
                    source: position.connectionId.slice(0, 8),
                  }),
                ]
              : []),
            ...(covered ? [m.workflows_setup_position_covered()] : []),
            ...(otherSource ? [m.workflows_setup_position_other_source()] : []),
          ].join(' · ')}
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
        {[
          m.workflows_setup_result_activated_count({
            count: count('activated'),
          }),
          ...(count('failed')
            ? [
                m.workflows_setup_result_failed_count({
                  count: count('failed'),
                }),
              ]
            : []),
          ...(count('uncertain')
            ? [
                m.workflows_setup_result_uncertain_count({
                  count: count('uncertain'),
                }),
              ]
            : []),
        ].join(' · ')}
      </p>
      <ul
        className="replenishment-targets"
        aria-label={m.workflows_setup_results_label()}
      >
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
                  ? m.workflows_setup_result_activated()
                  : result.status === 'uncertain'
                    ? m.workflows_setup_result_uncertain()
                    : result.code === 'covered'
                      ? m.workflows_setup_result_covered()
                      : m.workflows_setup_result_failed()}
              </StatePill>
            </div>
            <p>{result.message}</p>
            {result.status === 'activated' ? (
              <Link
                className="workflow-repair-link"
                to="/app/$organizationId/inventory/$positionId"
                params={{ organizationId, positionId: result.positionId }}
              >
                {m.workflows_rule_stock_record()}{' '}
                <ArrowRight size={13} aria-hidden="true" />
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
            {retrying
              ? m.workflows_setup_retrying()
              : m.workflows_setup_retry_unconfirmed({
                  count: uncertain.length,
                })}
          </Button>
        ) : null}
        <Button disabled={retrying} onClick={done}>
          {m.common_done()}
        </Button>
      </div>
    </div>
  );
}
