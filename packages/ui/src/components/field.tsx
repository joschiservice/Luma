import { cn } from '@luma/ui/lib/utils';
import type { ComponentProps } from 'react';

/** Groups related form fields with consistent vertical spacing. */
function FieldGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-group"
      className={cn('flex w-full flex-col gap-5', className)}
      {...props}
    />
  );
}

/**
 * Groups a field's label, input, and feedback; accepts disabled and invalid state data
 * attributes.
 */
function Field({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      role="group"
      data-slot="field"
      className={cn('group/field flex w-full flex-col gap-2', className)}
      {...props}
    />
  );
}

/** Renders a field label; pass htmlFor to associate it with the input. */
function FieldLabel({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label
      data-slot="field-label"
      className={cn(
        'text-sm font-semibold text-foreground group-data-[disabled=true]/field:text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

/** Renders field help text; link its ID from the input's aria-describedby when applicable. */
function FieldDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn('text-sm leading-normal text-muted-foreground', className)}
      {...props}
    />
  );
}

/**
 * Announces validation feedback, deduplicating supplied error messages unless explicit
 * children are provided.
 */
function FieldError({
  className,
  children,
  errors,
  ...props
}: ComponentProps<'div'> & {
  errors?: readonly ({ message?: string } | undefined)[];
}) {
  const messages = [
    ...new Set(
      errors?.flatMap((error) => (error?.message ? [error.message] : [])),
    ),
  ];
  const content =
    children ??
    (messages.length === 1 ? (
      messages[0]
    ) : messages.length > 1 ? (
      <ul className="ml-4 flex list-disc flex-col gap-1">
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    ) : null);
  if (!content) return null;

  return (
    <div
      role="alert"
      data-slot="field-error"
      className={cn('text-sm text-destructive', className)}
      {...props}
    >
      {content}
    </div>
  );
}

export { Field, FieldDescription, FieldError, FieldGroup, FieldLabel };
