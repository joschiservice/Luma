import type { RunDetail } from '@luma/simulator-contract';
import {
  chaosPresets,
  type IncidentKindName,
  incidentKindNames,
  incidentKinds,
  transportFaults,
} from '@luma/simulator-core';
import { Badge } from '@luma/ui/components/primitives/badge';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { Switch } from '@luma/ui/components/primitives/switch';
import { type FormEvent, type ReactNode, useReducer, useState } from 'react';

import { errorMessage } from '../../api';
import { NumberField, RateField } from '../../components/fields';
import {
  chaosProblems,
  type ChaosProfile,
  chaosReducer,
  describeChaos,
} from '../../lib/chaos';
import { formatPercent, incidentUnitLabel } from '../../lib/format';
import { faultLabels } from '../../lib/labels';
import { useControl, useProfiles } from '../../queries';
import { presetLabel } from '../runs/create-run-dialog';
import { FaultRules } from './fault-rules';
import { OverridesEditor, WindowsEditor } from './targeted';

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card as="section" aria-labelledby={id}>
      <CardHeader>
        <div>
          <CardTitle as="h3" id={id}>
            {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
      </CardHeader>
      <div className="sim-field-grid">{children}</div>
    </Card>
  );
}

/**
 * Edits the run's chaos profile and arms precise faults. Edits stay local until applied; while
 * there are none, the editor follows the profile the run reports.
 */
export function ChaosView({ run }: { run: RunDetail }) {
  return (
    <div className="sim-stack">
      <ChaosEditor run={run} />
      <FaultRules run={run} />
    </div>
  );
}

function ChaosEditor({ run }: { run: RunDetail }) {
  const profiles = useProfiles();
  const control = useControl(run.id);
  const [draft, dispatch] = useReducer(chaosReducer, {
    profile: run.chaosProfile,
    dirty: false,
  });
  const serverProfile = JSON.stringify(run.chaosProfile);
  const [seen, setSeen] = useState(serverProfile);
  if (serverProfile !== seen) {
    setSeen(serverProfile);
    if (!draft.dirty) dispatch({ type: 'load', profile: run.chaosProfile });
  }
  const profile = draft.profile;
  const presets: { name: string; profile: ChaosProfile }[] =
    profiles.data?.chaos ??
    Object.entries(chaosPresets).map(([name, preset]) => ({
      name,
      profile: preset,
    }));
  const problems = chaosProblems(profile);
  const mixTotal = transportFaults.reduce(
    (sum, fault) => sum + (profile.transport.mix[fault] ?? 0),
    0,
  );

  function apply(event: FormEvent) {
    event.preventDefault();
    if (problems.length) return;
    control.mutate(
      { action: 'chaos', chaos: profile },
      {
        onSuccess: (detail) =>
          dispatch({ type: 'load', profile: detail.chaosProfile }),
      },
    );
  }

  return (
    <form className="sim-stack" onSubmit={apply} aria-labelledby="chaos-title">
      <div className="sim-toolbar">
        <div>
          <h2 id="chaos-title" className="sim-section-title">
            Chaos profile
          </h2>
          <p className="sim-muted">
            How often provider requests and webhooks fail, and how often
            operational incidents occur. Applied changes take effect at once.
          </p>
        </div>
      </div>
      <fieldset className="sim-fieldset">
        <legend>Start from a preset</legend>
        <div className="sim-choices sim-choices-grid">
          {presets.map((preset) => (
            <label key={preset.name} className="sim-choice">
              <input
                type="radio"
                name="chaos-preset"
                value={preset.name}
                checked={profile.preset === preset.name}
                onChange={() =>
                  dispatch({ type: 'preset', profile: preset.profile })
                }
              />
              <span className="sim-choice-body">
                <strong>
                  {presetLabel(preset.name)}{' '}
                  {run.chaosProfile.preset === preset.name ? (
                    <Badge tone="accent">Applied</Badge>
                  ) : null}
                </strong>
                <ul className="sim-plain-list sim-muted">
                  {describeChaos(preset.profile).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <Section
        id="chaos-transport"
        title="Provider requests"
        description="Applies to every provider instance unless an override or window says otherwise."
      >
        <RateField
          label="Transport error rate"
          value={profile.transport.errorRate}
          maxPercent={20}
          description="Share of requests that fail."
          onChange={(value) =>
            dispatch({ type: 'transport', field: 'errorRate', value })
          }
        />
        <RateField
          label="Response loss rate"
          value={profile.transport.responseLossRate}
          maxPercent={5}
          step={0.01}
          description="Share of committed writes whose response never arrives."
          onChange={(value) =>
            dispatch({ type: 'transport', field: 'responseLossRate', value })
          }
        />
        <label className="sim-switch">
          <Switch
            aria-labelledby="chaos-rate-limits"
            aria-describedby="chaos-rate-limits-hint"
            checked={profile.transport.rateLimits}
            onCheckedChange={(value) =>
              dispatch({ type: 'rate-limits', value })
            }
          />
          <span>
            <span id="chaos-rate-limits">Provider rate limits</span>
            <span id="chaos-rate-limits-hint" className="sim-muted">
              {' '}
              — Shopify’s query-cost bucket and JTL’s request budget.
            </span>
          </span>
        </label>
        <NumberField
          label="Search index lag"
          unit="ms"
          value={profile.transport.indexLagMs}
          min={0}
          max={3_600_000}
          description="How long changes stay invisible to filtered lists and search."
          onChange={(value) =>
            dispatch({
              type: 'transport',
              field: 'indexLagMs',
              value: value ?? 0,
            })
          }
        />
        <NumberField
          label="Timeout after"
          unit="ms"
          value={profile.transport.timeoutMs}
          min={1_000}
          max={120_000}
          description="How long a simulated timeout holds the connection."
          onChange={(value) =>
            dispatch({
              type: 'transport',
              field: 'timeoutMs',
              value: value ?? 1_000,
            })
          }
        />
        <NumberField
          label="Latency median"
          unit="ms"
          value={profile.transport.latency.medianMs}
          min={0}
          max={600_000}
          onChange={(value) =>
            dispatch({
              type: 'latency',
              target: 'transport',
              field: 'medianMs',
              value: value ?? 0,
            })
          }
        />
        <NumberField
          label="Latency p99"
          unit="ms"
          value={profile.transport.latency.p99Ms}
          min={0}
          max={3_600_000}
          onChange={(value) =>
            dispatch({
              type: 'latency',
              target: 'transport',
              field: 'p99Ms',
              value: value ?? 0,
            })
          }
        />
      </Section>
      <Section
        id="chaos-mix"
        title="Failure mix"
        description="Relative weights of failure kinds when a request fails."
      >
        {transportFaults.map((fault) => {
          const weight = profile.transport.mix[fault] ?? 0;

          return (
            <NumberField
              key={fault}
              label={faultLabels[fault]}
              value={weight}
              min={0}
              max={1_000}
              description={
                mixTotal > 0
                  ? `${formatPercent(weight / mixTotal)} of failures`
                  : 'No weights set'
              }
              onChange={(value) =>
                dispatch({ type: 'mix', fault, value: value ?? 0 })
              }
            />
          );
        })}
      </Section>
      <Section
        id="chaos-webhooks"
        title="Webhooks"
        description="Delivery problems for webhooks the shops send."
      >
        <RateField
          label="Drop rate"
          value={profile.webhooks.dropRate}
          maxPercent={20}
          onChange={(value) =>
            dispatch({ type: 'webhooks', field: 'dropRate', value })
          }
        />
        <RateField
          label="Duplicate rate"
          value={profile.webhooks.duplicateRate}
          maxPercent={20}
          onChange={(value) =>
            dispatch({ type: 'webhooks', field: 'duplicateRate', value })
          }
        />
        <RateField
          label="Reorder rate"
          value={profile.webhooks.reorderRate}
          maxPercent={20}
          description="Share delayed long enough to arrive after later events."
          onChange={(value) =>
            dispatch({ type: 'webhooks', field: 'reorderRate', value })
          }
        />
        <NumberField
          label="Delay median"
          unit="ms"
          value={profile.webhooks.delay.medianMs}
          min={0}
          max={600_000}
          onChange={(value) =>
            dispatch({
              type: 'latency',
              target: 'webhooks',
              field: 'medianMs',
              value: value ?? 0,
            })
          }
        />
        <NumberField
          label="Delay p99"
          unit="ms"
          value={profile.webhooks.delay.p99Ms}
          min={0}
          max={3_600_000}
          onChange={(value) =>
            dispatch({
              type: 'latency',
              target: 'webhooks',
              field: 'p99Ms',
              value: value ?? 0,
            })
          }
        />
      </Section>
      <Section
        id="chaos-incidents"
        title="Operational incidents"
        description="Expected incidents per kind. Each one is recorded as ground truth for the scorecard."
      >
        {incidentKindNames.map((kind: IncidentKindName) => (
          <NumberField
            key={kind}
            label={incidentKinds[kind].label}
            unit={incidentUnitLabel(incidentKinds[kind].unit)}
            value={profile.incidents[kind] ?? 0}
            min={0}
            max={10_000}
            step={0.01}
            description={incidentKinds[kind].description}
            onChange={(value) =>
              dispatch({ type: 'incident', kind, value: value ?? 0 })
            }
          />
        ))}
      </Section>
      <OverridesEditor
        run={run}
        overrides={profile.overrides}
        dispatch={dispatch}
      />
      <WindowsEditor run={run} windows={profile.windows} dispatch={dispatch} />
      <div
        className="sim-apply-bar"
        role="region"
        aria-label="Apply chaos profile"
      >
        <div aria-live="polite">
          {problems.length ? (
            <ul className="sim-list sim-error-text">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : control.isError ? (
            <p className="sim-error-text">
              Not applied: {errorMessage(control.error)}
            </p>
          ) : (
            <p>
              {draft.dirty
                ? `Unapplied changes · ${presetLabel(profile.preset)}`
                : `The run uses ${presetLabel(run.chaosProfile.preset).toLowerCase()}.`}
            </p>
          )}
        </div>
        <div className="sim-actions">
          <Button
            type="button"
            variant="outline"
            disabled={!draft.dirty || control.isPending}
            onClick={() =>
              dispatch({ type: 'load', profile: run.chaosProfile })
            }
          >
            Discard changes
          </Button>
          <Button
            type="submit"
            disabled={!draft.dirty || problems.length > 0 || control.isPending}
          >
            {control.isPending ? 'Applying…' : 'Apply chaos profile'}
          </Button>
        </div>
      </div>
    </form>
  );
}
