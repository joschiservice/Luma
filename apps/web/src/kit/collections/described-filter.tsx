import type { CollectionCondition, CollectionDomain } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Checkbox } from '@luma/ui/components/primitives/checkbox';
import type { ConditionField } from '@luma/ui/components/primitives/condition-builder';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Textarea } from '@luma/ui/components/primitives/textarea';
import { describeCondition } from '@luma/ui/lib/collection-conditions';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useId, useState } from 'react';

import { createWebApiClient } from '../../lib/api-client';
import { privateQueryDefaults } from '../../lib/private-query';

const api = createWebApiClient();

type AdaptiveViewDraft = Awaited<ReturnType<typeof api.adaptiveViews.generate>>;

/** Conditions a draft proposes for this list, or why it proposes none. */
export function proposedConditions(
  draft: AdaptiveViewDraft,
  domain: CollectionDomain,
): { conditions: CollectionCondition[]; reason: string | null } {
  if (draft.status !== 'ready' || !draft.query)
    return { conditions: [], reason: draft.explanation || null };
  if (draft.query.domain !== domain)
    return {
      conditions: [],
      reason: m.collections_describe_other_list(),
    };

  return { conditions: draft.query.state.where.conditions, reason: null };
}

/**
 * Turns a described filter into conditions the member reviews before they apply. Nothing
 * changes the list until the member applies the chosen chips. Requests use the existing view
 * drafting route and its model processing rules; the control hides when drafting is off.
 */
export function DescribedFilter({
  organizationId,
  domain,
  listName,
  fields,
  apply,
}: {
  organizationId: string;
  domain: CollectionDomain;
  /** The list's name, so the description is read for this list. */
  listName: string;
  fields: readonly ConditionField[];
  apply: (conditions: CollectionCondition[]) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const availability = useQuery({
    ...privateQueryDefaults,
    queryKey: [
      'private',
      'organization',
      organizationId,
      'adaptive',
      'availability',
    ],
    queryFn: ({ signal }) =>
      api.adaptive.availability({ params: { organizationId } }, { signal }),
  });
  const draft = useMutation({
    mutationFn: (text: string) =>
      api.adaptiveViews.generate({
        params: { organizationId },
        body: {
          prompt: m.collections_describe_prompt({ list: listName, text }),
        },
      }),
    onSuccess: (result) => {
      const { conditions } = proposedConditions(result, domain);
      setChosen(new Set(conditions.map((_, index) => index)));
    },
  });
  if (!availability.data?.generation) return null;
  const proposal = draft.data ? proposedConditions(draft.data, domain) : null;
  const label = (condition: CollectionCondition) => {
    const field = fields.find((item) => item.id === condition.field);

    return field ? describeCondition(field, condition) : condition.field;
  };
  const close = () => {
    setOpen(false);
    setPrompt('');
    draft.reset();
  };

  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        <Sparkles aria-hidden="true" />
        {m.collections_describe_open()}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
      >
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (prompt.trim()) draft.mutate(prompt.trim());
            }}
          >
            <DialogHeader>
              <DialogTitle>{m.collections_describe_title()}</DialogTitle>
              <DialogDescription>
                {m.collections_describe_note()}
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor={`${id}-prompt`}>
                {m.collections_describe_label()}
              </FieldLabel>
              <Textarea
                id={`${id}-prompt`}
                value={prompt}
                maxLength={1500}
                placeholder={m.collections_describe_placeholder()}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </Field>
            <Button
              type="submit"
              variant="outline"
              disabled={!prompt.trim() || draft.isPending}
            >
              {draft.isPending
                ? m.collections_describe_pending()
                : m.collections_describe_propose()}
            </Button>
          </form>
          {draft.isError ? (
            <Alert tone="danger" role="alert">
              {m.collections_describe_failed()}
            </Alert>
          ) : proposal?.reason ? (
            <Alert role="status">{proposal.reason}</Alert>
          ) : proposal ? (
            <fieldset className="collection-describe-proposal">
              <legend>{m.collections_describe_review()}</legend>
              {proposal.conditions.map((condition, index) => (
                <label key={index}>
                  <Checkbox
                    checked={chosen.has(index)}
                    onChange={(event) => {
                      const next = new Set(chosen);
                      if (event.target.checked) next.add(index);
                      else next.delete(index);
                      setChosen(next);
                    }}
                  />
                  {label(condition)}
                </label>
              ))}
              {draft.data?.warnings.map((warning) => (
                <p key={warning} className="collection-describe-warning">
                  {warning}
                </p>
              ))}
            </fieldset>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={close}>
              {m.common_cancel()}
            </Button>
            <Button
              disabled={!proposal || !chosen.size}
              onClick={() => {
                apply(
                  (proposal?.conditions ?? []).filter((_, index) =>
                    chosen.has(index),
                  ),
                );
                close();
              }}
            >
              {m.collections_describe_apply({ count: chosen.size })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
