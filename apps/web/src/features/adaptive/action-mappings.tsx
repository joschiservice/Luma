import type { AdaptiveViewQuery } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { useQuery } from '@tanstack/react-query';

import { adaptiveApi, adaptiveAvailabilityOptions, adaptiveKey } from './data';
import { columnLabel } from './presentation';

/** Maps only catalog-supported targets and typed inputs; the server revalidates every binding. */
export function ActionMappings({
  organizationId,
  query,
  change,
}: {
  organizationId: string;
  query: AdaptiveViewQuery;
  change: (query: AdaptiveViewQuery) => void;
}) {
  const availability = useQuery(adaptiveAvailabilityOptions(organizationId));
  const definitions = useQuery({
    queryKey: [
      ...adaptiveKey(organizationId),
      'action-definitions',
      query.domain,
    ],
    queryFn: ({ signal }) =>
      adaptiveApi.adaptiveActions.definitions(
        { params: { organizationId }, query: { domain: query.domain } },
        { signal },
      ),
    enabled: availability.data?.actions === true,
  });
  if (!availability.data?.actions) return null;
  const key = (target: {
    kind: string;
    id: string;
    version?: string | undefined;
  }) => `${target.kind}:${target.id}:${target.version ?? ''}`;

  return (
    <section className="adaptive-editor-group">
      <h2>{m.adaptive_actions()}</h2>
      <p>{m.adaptive_action_note()}</p>
      {definitions.isError ? (
        <Alert tone="warning">{m.adaptive_load_failed()}</Alert>
      ) : null}
      {query.actions.map((action) => {
        const definition = definitions.data?.items.find(
          (item) => key(item.target) === key(action.target),
        );
        const update = (next: typeof action) =>
          change({
            ...query,
            actions: query.actions.map((item) =>
              item.id === action.id ? next : item,
            ),
          });

        return (
          <section key={action.id} className="adaptive-editor-group">
            <div className="adaptive-editor-pair">
              <Field>
                <FieldLabel>{m.adaptive_label_en()}</FieldLabel>
                <Input
                  value={action.label.en}
                  aria-label={m.adaptive_label_en()}
                  onChange={(event) =>
                    update({
                      ...action,
                      label: { ...action.label, en: event.target.value },
                    })
                  }
                />
              </Field>
              <Field>
                <FieldLabel>{m.adaptive_label_de()}</FieldLabel>
                <Input
                  value={action.label.de}
                  aria-label={m.adaptive_label_de()}
                  onChange={(event) =>
                    update({
                      ...action,
                      label: { ...action.label, de: event.target.value },
                    })
                  }
                />
              </Field>
            </div>
            <p>
              {columnLabel(action.target.id)} {action.target.version}
            </p>
            {!definition?.available ? (
              <Alert tone="warning">
                {definition?.reason ?? m.adaptive_unavailable()}
              </Alert>
            ) : null}
            <h3>{m.adaptive_action_inputs()}</h3>
            {(
              definition?.inputs ??
              Object.keys(action.inputs).map((input) => ({
                key: input,
                type: 'string' as const,
              }))
            ).map((input) => {
              const binding = action.inputs[input.key] ?? {
                source: 'literal' as const,
                value: '',
              };
              const bind = (value: typeof binding) =>
                update({
                  ...action,
                  inputs: { ...action.inputs, [input.key]: value },
                });

              return (
                <div className="adaptive-editor-pair" key={input.key}>
                  <Field>
                    <FieldLabel>{columnLabel(input.key)}</FieldLabel>
                    <Select
                      aria-label={m.adaptive_binding_source()}
                      value={binding.source}
                      options={[
                        { value: 'row', label: m.adaptive_row_value() },
                        { value: 'literal', label: m.adaptive_fixed_value() },
                      ]}
                      onValueChange={(source) => {
                        if (source)
                          bind(
                            source === 'row'
                              ? { source, field: query.columns[0] ?? 'id' }
                              : {
                                  source,
                                  value:
                                    input.type === 'number'
                                      ? 0
                                      : input.type === 'boolean'
                                        ? false
                                        : '',
                                },
                          );
                      }}
                    />
                  </Field>
                  <Field>
                    <FieldLabel>{m.adaptive_value()}</FieldLabel>
                    {binding.source === 'row' ? (
                      <Select
                        aria-label={m.adaptive_value()}
                        value={binding.field}
                        options={[
                          ...new Set(['id', ...query.columns, binding.field]),
                        ].map((field) => ({
                          value: field,
                          label: columnLabel(field),
                        }))}
                        onValueChange={(field) => {
                          if (field) bind({ source: 'row', field });
                        }}
                      />
                    ) : input.type === 'boolean' ? (
                      <Select
                        aria-label={m.adaptive_value()}
                        value={binding.value === true ? 'true' : 'false'}
                        options={[
                          { value: 'true', label: m.adaptive_yes() },
                          { value: 'false', label: m.adaptive_no() },
                        ]}
                        onValueChange={(value) =>
                          bind({ source: 'literal', value: value === 'true' })
                        }
                      />
                    ) : (
                      <Input
                        type={input.type === 'number' ? 'number' : 'text'}
                        aria-label={m.adaptive_value()}
                        value={String(binding.value ?? '')}
                        onChange={(event) =>
                          bind({
                            source: 'literal',
                            value:
                              input.type === 'number'
                                ? Number(event.target.value)
                                : event.target.value,
                          })
                        }
                      />
                    )}
                  </Field>
                </div>
              );
            })}
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                change({
                  ...query,
                  actions: query.actions.filter(
                    (item) => item.id !== action.id,
                  ),
                })
              }
            >
              {m.adaptive_remove()}
            </Button>
          </section>
        );
      })}
      <Select
        aria-label={m.adaptive_add_action()}
        value={null}
        placeholder={m.adaptive_add_action()}
        disabled={query.actions.length >= 8}
        options={(definitions.data?.items ?? []).map((definition) => ({
          value: key(definition.target),
          label: `${columnLabel(definition.target.id)} ${definition.target.version ?? ''}`,
          disabled: !definition.available,
        }))}
        onValueChange={(value) => {
          const definition = definitions.data?.items.find(
            (item) => key(item.target) === value,
          );
          if (!definition) return;
          const inputs: AdaptiveViewQuery['actions'][number]['inputs'] = {};
          for (const input of definition.inputs)
            inputs[input.key] =
              input.key === 'attentionKey' &&
              query.columns.includes('attentionKey')
                ? { source: 'row', field: 'attentionKey' }
                : {
                    source: 'literal',
                    value:
                      input.type === 'number'
                        ? 24
                        : input.type === 'boolean'
                          ? false
                          : '',
                  };
          change({
            ...query,
            actions: [
              ...query.actions,
              {
                id: crypto.randomUUID(),
                label: {
                  en: columnLabel(definition.target.id),
                  de: columnLabel(definition.target.id),
                },
                target: definition.target,
                inputs,
              },
            ],
          });
        }}
      />
    </section>
  );
}
