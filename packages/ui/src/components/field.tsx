import type { ComponentProps } from 'react';
import { cn } from '@luma/ui/lib/utils';

// The small subset of shadcn Field used by Luma's initial forms.
function FieldGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-group"
      className={cn('flex w-full flex-col gap-5', className)}
      {...props}
    />
  );
}

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

function FieldDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn('text-sm leading-normal text-muted-foreground', className)}
      {...props}
    />
  );
}

function FieldError({
  className,
  children,
  errors,
  ...props
}: ComponentProps<'div'> & {
  errors?: ReadonlyArray<{ message?: string } | undefined>;
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

export { Field, FieldLabel, FieldDescription, FieldError, FieldGroup };
