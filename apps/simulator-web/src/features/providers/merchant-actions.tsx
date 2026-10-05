import type { RunDetail } from '@luma/simulator-contract';
import { orderActionSchema } from '@luma/simulator-contract';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';

import { errorMessage } from '../../api';
import { NumberField, SelectField } from '../../components/fields';
import { useControl } from '../../queries';

interface Line {
  key: number;
  sku: string;
  quantity: number | undefined;
}

/** Parses a raw provider command; returns an error message for anything but a JSON object. */
export function parseCommand(
  text: string,
): { command: Record<string, unknown> } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { error: `Not valid JSON: ${errorMessage(error)}` };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return {
      error: 'The command must be a JSON object, such as {"kind": "…"}.',
    };

  return { command: value as Record<string, unknown> };
}

/**
 * Places a shop order through the simulated integration, as a customer would. Lines are
 * optional; without them the shop draws a basket from its assortment.
 */
function PlaceOrder({ run }: { run: RunDetail }) {
  const control = useControl(run.id);
  const id = useId();
  const shops = run.instances.filter((instance) => instance.kind === 'shopify');
  const [shop, setShop] = useState('any');
  const [shipping, setShipping] = useState<'any' | 'standard' | 'express'>(
    'any',
  );
  const [lines, setLines] = useState<Line[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [placed, setPlaced] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = orderActionSchema.safeParse({
      action: 'order',
      ...(shop === 'any' ? {} : { shop }),
      ...(shipping === 'any' ? {} : { shipping }),
      ...(lines.length
        ? {
            lines: lines.map((line) => ({
              sku: line.sku.trim(),
              quantity: line.quantity,
            })),
          }
        : {}),
    });
    if (!parsed.success) {
      setProblem('Each line needs a SKU and a quantity from 1 to 1,000.');

      return;
    }
    setProblem(null);
    setPlaced(false);
    control.mutate(parsed.data, { onSuccess: () => setPlaced(true) });
  }

  return (
    <Card as="section" aria-labelledby={`${id}-title`}>
      <CardHeader>
        <div>
          <CardTitle id={`${id}-title`}>Place an order</CardTitle>
          <CardDescription>
            A customer order in a shop, imported into the ERP like any other.
          </CardDescription>
        </div>
      </CardHeader>
      <form className="sim-form" onSubmit={submit} noValidate>
        <div className="sim-field-grid">
          <SelectField
            label="Shop"
            value={shop}
            options={[
              { value: 'any', label: 'Any shop' },
              ...shops.map((s) => ({ value: s.name, label: s.label })),
            ]}
            onChange={setShop}
          />
          <SelectField<'any' | 'standard' | 'express'>
            label="Shipping"
            value={shipping}
            options={[
              { value: 'any', label: 'Chosen by the shop' },
              { value: 'standard', label: 'Standard' },
              { value: 'express', label: 'Express' },
            ]}
            onChange={setShipping}
          />
        </div>
        <fieldset className="sim-fieldset">
          <legend>Lines (optional)</legend>
          {lines.length === 0 ? (
            <p className="sim-muted">
              No lines: the shop draws a basket from its assortment.
            </p>
          ) : (
            <ol className="sim-entries">
              {lines.map((line, index) => (
                <li key={line.key} className="sim-line">
                  <Field>
                    <FieldLabel htmlFor={`${id}-sku-${line.key}`}>
                      SKU, line {index + 1}
                    </FieldLabel>
                    <Input
                      id={`${id}-sku-${line.key}`}
                      value={line.sku}
                      spellCheck={false}
                      onChange={(event) => {
                        const sku = event.currentTarget.value;
                        setLines((list) =>
                          list.map((l) =>
                            l.key === line.key ? { ...l, sku } : l,
                          ),
                        );
                      }}
                    />
                  </Field>
                  <NumberField
                    label={`Quantity, line ${index + 1}`}
                    value={line.quantity}
                    min={1}
                    max={1_000}
                    onChange={(quantity) =>
                      setLines((list) =>
                        list.map((l) =>
                          l.key === line.key ? { ...l, quantity } : l,
                        ),
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setLines((list) => list.filter((l) => l.key !== line.key))
                    }
                  >
                    <Trash2 aria-hidden="true" />
                    Remove line {index + 1}
                  </Button>
                </li>
              ))}
            </ol>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={lines.length >= 50}
            onClick={() =>
              setLines((list) => [
                ...list,
                {
                  key: (list.at(-1)?.key ?? 0) + 1,
                  sku: '',
                  quantity: 1,
                },
              ])
            }
          >
            <Plus aria-hidden="true" />
            Add line
          </Button>
        </fieldset>
        <div aria-live="polite">
          {problem || control.isError ? (
            <p className="sim-error-text" role="alert">
              {problem ??
                `The order was not placed: ${errorMessage(control.error)}`}
            </p>
          ) : placed ? (
            <p>Order placed. Follow it in the journal.</p>
          ) : null}
        </div>
        <div className="sim-actions">
          <Button type="submit" disabled={control.isPending}>
            {control.isPending ? 'Placing…' : 'Place order'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Sends a raw provider command for expert reproduction. */
function ProviderCommand({ run }: { run: RunDetail }) {
  const control = useControl(run.id);
  const id = useId();
  const [instance, setInstance] = useState(run.instances[0]?.name ?? '');
  const [text, setText] = useState('{\n  "kind": ""\n}');
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = parseCommand(text);
    if ('error' in parsed) {
      setProblem(parsed.error);

      return;
    }
    setProblem(null);
    setSent(false);
    control.mutate(
      { action: 'command', instance, command: parsed.command },
      { onSuccess: () => setSent(true) },
    );
  }

  return (
    <Card as="section" aria-labelledby={`${id}-title`}>
      <CardHeader>
        <div>
          <CardTitle id={`${id}-title`}>Provider command</CardTitle>
          <CardDescription>
            Sends a command straight to one simulated system, bypassing the
            integration. For reproducing exact provider states.
          </CardDescription>
        </div>
      </CardHeader>
      <form className="sim-form" onSubmit={submit} noValidate>
        <SelectField
          label="Instance"
          value={instance}
          options={run.instances.map((i) => ({
            value: i.name,
            label: i.label,
          }))}
          onChange={setInstance}
        />
        <Field>
          <FieldLabel htmlFor={`${id}-command`}>Command JSON</FieldLabel>
          <Textarea
            id={`${id}-command`}
            className="sim-mono"
            value={text}
            spellCheck={false}
            rows={6}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${id}-command-hint`}
            onChange={(event) => setText(event.currentTarget.value)}
          />
          <FieldDescription id={`${id}-command-hint`}>
            The provider simulator validates the command and its kind.
          </FieldDescription>
        </Field>
        <div aria-live="polite">
          {problem || control.isError ? (
            <p className="sim-error-text" role="alert">
              {problem ?? `Rejected: ${errorMessage(control.error)}`}
            </p>
          ) : sent ? (
            <p>Command applied.</p>
          ) : null}
        </div>
        <div className="sim-actions">
          <Button type="submit" disabled={control.isPending}>
            {control.isPending ? 'Sending…' : 'Send command'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Merchant actions that change the simulated world on purpose. */
export function MerchantActions({ run }: { run: RunDetail }) {
  return (
    <div className="sim-two-column">
      <PlaceOrder run={run} />
      <ProviderCommand run={run} />
    </div>
  );
}
