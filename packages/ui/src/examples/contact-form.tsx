import { useForm } from '@tanstack/react-form';
import { useMutation } from '@tanstack/react-query';
import { useId, useRef } from 'react';
import { match } from 'ts-pattern';

import { Button } from '../components/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '../components/field';
import { Input } from '../components/input';
import { Spinner } from '../components/spinner';
import {
  type Contact,
  type ContactInput,
  contactSchema,
  saveContactResultSchema,
} from './contact-schema';

export interface ContactFormExampleProps {
  saveContact: (contact: Contact) => Promise<unknown>;
}

/** Workshop example: the host supplies I/O; the form owns only its draft. */
export function ContactFormExample({ saveContact }: ContactFormExampleProps) {
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const save = useMutation({
    mutationFn: async (contact: Contact) =>
      saveContactResultSchema.parse(await saveContact(contact)),
    retry: false,
  });
  const form = useForm({
    defaultValues: { name: '', email: '' } satisfies ContactInput,
    // Zod implements Standard Schema; no library-specific resolver is needed.
    validators: { onChange: contactSchema, onSubmit: contactSchema },
    listeners: { onChange: () => save.reset() },
    onSubmitInvalid: ({ formApi }) => {
      if (!formApi.getFieldMeta('name')?.isValid) nameRef.current?.focus();
      else emailRef.current?.focus();
    },
    onSubmit: async ({ value }) => {
      try {
        // Form validators report issues but do not apply schema transforms.
        await save.mutateAsync(contactSchema.parse(value));
      } catch {
        // Query owns request/response failures, rendered below; retain the draft.
      }
    },
  });
  const outcome = save.data
    ? match(save.data)
        .with({ kind: 'saved' }, () => ({
          role: 'status' as const,
          message: 'Contact saved.',
        }))
        .with({ kind: 'email-conflict' }, () => ({
          role: 'alert' as const,
          message: 'This email is already in use. Choose another address.',
        }))
        .exhaustive()
    : null;

  return (
    <form
      noValidate
      aria-labelledby={`${id}-heading`}
      className="flex w-full max-w-md flex-col gap-6 rounded-xl border border-border bg-card p-6 text-card-foreground"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <header className="flex flex-col gap-2">
        <h2 id={`${id}-heading`} className="font-heading text-3xl">
          Contact details
        </h2>
        <p className="text-sm text-muted-foreground">
          A small form with room for clear feedback.
        </p>
      </header>
      <FieldGroup>
        <form.Field name="name">
          {(field) => {
            const invalid =
              field.state.meta.isTouched && !field.state.meta.isValid;

            return (
              <Field data-invalid={invalid} data-disabled={save.isPending}>
                <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                <Input
                  ref={nameRef}
                  id={`${id}-name`}
                  name={field.name}
                  autoComplete="name"
                  required
                  disabled={save.isPending}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  aria-invalid={invalid}
                  aria-describedby={invalid ? `${id}-name-error` : undefined}
                />
                {invalid ? (
                  <FieldError
                    id={`${id}-name-error`}
                    errors={field.state.meta.errors}
                  />
                ) : null}
              </Field>
            );
          }}
        </form.Field>
        <form.Field name="email">
          {(field) => {
            const invalid =
              field.state.meta.isTouched && !field.state.meta.isValid;

            return (
              <Field data-invalid={invalid} data-disabled={save.isPending}>
                <FieldLabel htmlFor={`${id}-email`}>Email</FieldLabel>
                <Input
                  ref={emailRef}
                  id={`${id}-email`}
                  name={field.name}
                  type="email"
                  autoComplete="email"
                  required
                  disabled={save.isPending}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  aria-invalid={invalid}
                  aria-describedby={
                    invalid
                      ? `${id}-email-hint ${id}-email-error`
                      : `${id}-email-hint`
                  }
                />
                <FieldDescription id={`${id}-email-hint`}>
                  Use an address where you can be reached.
                </FieldDescription>
                {invalid ? (
                  <FieldError
                    id={`${id}-email-error`}
                    errors={field.state.meta.errors}
                  />
                ) : null}
              </Field>
            );
          }}
        </form.Field>
      </FieldGroup>
      {save.isError ? (
        <p role="alert" className="text-sm text-destructive">
          We couldn’t save your changes. Try again.
        </p>
      ) : null}
      {outcome ? (
        <p role={outcome.role} className="text-sm">
          {outcome.message}
        </p>
      ) : null}
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <Button
            type="submit"
            disabled={isSubmitting}
            aria-busy={isSubmitting}
          >
            {isSubmitting ? (
              <Spinner aria-hidden="true" data-icon="inline-start" />
            ) : null}
            {isSubmitting ? 'Saving…' : 'Save contact'}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
