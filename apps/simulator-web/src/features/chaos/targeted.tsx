import type { RunDetail } from '@luma/simulator-contract';
import { type TransportFault, transportFaults } from '@luma/simulator-core';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Plus, Trash2 } from 'lucide-react';
import { type Dispatch, useId } from 'react';

import { NumberField, SelectField } from '../../components/fields';
import {
  type ChaosAction,
  type ChaosOverride,
  type ChaosWindow,
  nextWindowId,
} from '../../lib/chaos';
import {
  fromLocalInput,
  fromPercent,
  toLocalInput,
  toPercent,
} from '../../lib/format';
import { faultLabels, knownOperations } from '../../lib/labels';

const anyInstance = 'any';

function instanceOptions(run: RunDetail) {
  return [
    { value: anyInstance, label: 'All instances' },
    ...run.instances.map((instance) => ({
      value: instance.name,
      label: instance.label,
    })),
  ];
}

/** Drops keys whose value is undefined, as the profile schema expects absent fields. */
function compact<Value extends object>(value: Value): Value {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Value;
}

function OperationField({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const id = useId();

  return (
    <Field>
      <FieldLabel htmlFor={id}>Operation</FieldLabel>
      <Input
        id={id}
        list="sim-operations"
        placeholder="All operations"
        value={value ?? ''}
        onChange={(event) =>
          onChange(event.currentTarget.value.trim() || undefined)
        }
      />
    </Field>
  );
}

/** Suggests operation names for operation inputs on the page. */
export function OperationSuggestions() {
  return (
    <datalist id="sim-operations">
      {knownOperations
        .filter((operation) => operation !== '*')
        .map((operation) => (
          <option key={operation} value={operation} />
        ))}
    </datalist>
  );
}

/** Edits per-instance and per-operation transport overrides; later entries win. */
export function OverridesEditor({
  run,
  overrides,
  dispatch,
}: {
  run: RunDetail;
  overrides: ChaosOverride[];
  dispatch: Dispatch<ChaosAction>;
}) {
  return (
    <Card as="section" aria-labelledby="chaos-overrides">
      <CardHeader>
        <div>
          <CardTitle as="h3" id="chaos-overrides">
            Overrides
          </CardTitle>
          <CardDescription>
            Different error rates or latency for one instance or operation.
            Later overrides win where they overlap.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={overrides.length >= 50}
          onClick={() =>
            dispatch({ type: 'add-override', override: { errorRate: 0.05 } })
          }
        >
          <Plus aria-hidden="true" />
          Add override
        </Button>
      </CardHeader>
      {overrides.length === 0 ? (
        <p className="sim-muted">
          No overrides. Every instance follows the profile.
        </p>
      ) : (
        <ol className="sim-entries">
          {overrides.map((override, index) => {
            const update = (patch: Partial<ChaosOverride>) =>
              dispatch({
                type: 'update-override',
                index,
                override: compact({ ...override, ...patch }),
              });

            return (
              <li key={index} className="sim-entry">
                <fieldset className="sim-fieldset">
                  <legend>Override {index + 1}</legend>
                  <div className="sim-field-grid">
                    <SelectField
                      label="Instance"
                      value={override.instance ?? anyInstance}
                      options={instanceOptions(run)}
                      onChange={(value) =>
                        update({
                          instance: value === anyInstance ? undefined : value,
                        })
                      }
                    />
                    <OperationField
                      value={override.operation}
                      onChange={(operation) => update({ operation })}
                    />
                    <NumberField
                      label="Error rate"
                      unit="%"
                      optional
                      min={0}
                      max={100}
                      step={0.1}
                      value={
                        override.errorRate === undefined
                          ? undefined
                          : toPercent(override.errorRate)
                      }
                      description="Empty keeps the profile's rate."
                      onChange={(value) =>
                        update({
                          errorRate:
                            value === undefined
                              ? undefined
                              : fromPercent(value),
                        })
                      }
                    />
                    <NumberField
                      label="Latency median"
                      unit="ms"
                      optional
                      min={0}
                      max={600_000}
                      value={override.latency?.medianMs}
                      description="Empty keeps the profile's latency."
                      onChange={(medianMs) =>
                        update({
                          latency:
                            medianMs === undefined
                              ? undefined
                              : {
                                  medianMs,
                                  p99Ms: Math.max(
                                    medianMs,
                                    override.latency?.p99Ms ?? medianMs * 10,
                                  ),
                                },
                        })
                      }
                    />
                    <NumberField
                      label="Latency p99"
                      unit="ms"
                      optional
                      min={0}
                      max={3_600_000}
                      value={override.latency?.p99Ms}
                      disabled={!override.latency}
                      onChange={(p99Ms) => {
                        if (override.latency && p99Ms !== undefined)
                          update({ latency: { ...override.latency, p99Ms } });
                      }}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => dispatch({ type: 'remove-override', index })}
                  >
                    <Trash2 aria-hidden="true" />
                    Remove override {index + 1}
                  </Button>
                </fieldset>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

const noFault = 'none';

/**
 * Edits timed failure windows in simulation time. A window raises the error rate while it is
 * open and may force one failure kind; with a repeat interval it reopens on that cadence.
 */
export function WindowsEditor({
  run,
  windows,
  dispatch,
}: {
  run: RunDetail;
  windows: ChaosWindow[];
  dispatch: Dispatch<ChaosAction>;
}) {
  return (
    <Card as="section" aria-labelledby="chaos-windows">
      <CardHeader>
        <div>
          <CardTitle as="h3" id="chaos-windows">
            Timed windows
          </CardTitle>
          <CardDescription>
            Periods with a higher error rate, such as a nightly outage. Times
            use simulation time in your time zone.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={windows.length >= 50}
          onClick={() =>
            dispatch({
              type: 'add-window',
              window: {
                id: nextWindowId(windows),
                label: 'Degraded period',
                startsAt: Math.ceil(run.clock.now / 60_000) * 60_000 + 60_000,
                durationMs: 15 * 60_000,
                errorRate: 0.5,
              },
            })
          }
        >
          <Plus aria-hidden="true" />
          Add window
        </Button>
      </CardHeader>
      {windows.length === 0 ? (
        <p className="sim-muted">No timed windows.</p>
      ) : (
        <ol className="sim-entries">
          {windows.map((window, index) => (
            <WindowEntry
              key={window.id}
              run={run}
              window={window}
              onChange={(next) =>
                dispatch({
                  type: 'update-window',
                  index,
                  window: compact(next),
                })
              }
              onRemove={() => dispatch({ type: 'remove-window', index })}
            />
          ))}
        </ol>
      )}
    </Card>
  );
}

function WindowEntry({
  run,
  window,
  onChange,
  onRemove,
}: {
  run: RunDetail;
  window: ChaosWindow;
  onChange: (window: ChaosWindow) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const update = (patch: Partial<ChaosWindow>) =>
    onChange({ ...window, ...patch });

  return (
    <li className="sim-entry">
      <fieldset className="sim-fieldset">
        <legend>{window.label || window.id}</legend>
        <div className="sim-field-grid">
          <Field>
            <FieldLabel htmlFor={`${id}-label`}>Label</FieldLabel>
            <Input
              id={`${id}-label`}
              value={window.label}
              maxLength={120}
              onChange={(event) => update({ label: event.currentTarget.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-start`}>Starts</FieldLabel>
            <Input
              id={`${id}-start`}
              type="datetime-local"
              value={toLocalInput(window.startsAt)}
              onChange={(event) => {
                const startsAt = fromLocalInput(event.currentTarget.value);
                if (startsAt !== null) update({ startsAt });
              }}
            />
          </Field>
          <NumberField
            label="Duration"
            unit="min"
            min={1}
            max={7 * 1_440}
            value={window.durationMs / 60_000}
            onChange={(minutes) =>
              update({ durationMs: Math.round((minutes ?? 1) * 60_000) })
            }
          />
          <NumberField
            label="Repeat every"
            unit="min"
            optional
            min={1}
            max={30 * 1_440}
            value={
              window.everyMs === undefined ? undefined : window.everyMs / 60_000
            }
            description="Empty runs the window once."
            onChange={(minutes) =>
              update({
                everyMs:
                  minutes === undefined
                    ? undefined
                    : Math.round(minutes * 60_000),
              })
            }
          />
          <SelectField
            label="Instance"
            value={window.instance ?? anyInstance}
            options={instanceOptions(run)}
            onChange={(value) =>
              update({ instance: value === anyInstance ? undefined : value })
            }
          />
          <OperationField
            value={window.operation}
            onChange={(operation) => update({ operation })}
          />
          <NumberField
            label="Error rate"
            unit="%"
            min={0}
            max={100}
            step={0.1}
            value={toPercent(window.errorRate)}
            onChange={(value) => update({ errorRate: fromPercent(value ?? 0) })}
          />
          <SelectField<TransportFault | typeof noFault>
            label="Forced failure"
            value={window.fault ?? noFault}
            options={[
              { value: noFault, label: 'Follow the failure mix' },
              ...transportFaults.map((fault) => ({
                value: fault,
                label: faultLabels[fault],
              })),
            ]}
            onChange={(value) =>
              update({ fault: value === noFault ? undefined : value })
            }
          />
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
          <Trash2 aria-hidden="true" />
          Remove {window.label || 'window'}
        </Button>
      </fieldset>
    </li>
  );
}
