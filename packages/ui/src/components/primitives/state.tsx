import { Check, X } from 'lucide-react';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/utils';

/**
 * Where a piece of work stands. `running` is active work and pulses unless the
 * reader prefers reduced motion. `verified` means the intended outcome was
 * observed, not merely that a request succeeded.
 */
export type OperationalState =
  | 'idle'
  | 'waiting'
  | 'running'
  | 'approval'
  | 'attention'
  | 'error'
  | 'verified';

/** Marks an operational state. It is decorative; always pair it with a text label. */
export function StateDot({
  state,
  className,
}: {
  state: OperationalState;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-state={state}
      className={cn('lu-state-dot', className)}
    >
      {state === 'verified' ? (
        <Check strokeWidth={3.2} />
      ) : state === 'error' ? (
        <X strokeWidth={3.2} />
      ) : (
        <span className="lu-state-dot-core" />
      )}
    </span>
  );
}

/** Labels an operational state with a dot and short text, such as "Waiting for approval". */
export function StatePill({
  state,
  className,
  children,
  ...props
}: ComponentProps<'span'> & { state: OperationalState }) {
  return (
    <span
      {...props}
      data-state={state}
      className={cn('lu-state-pill', className)}
    >
      <StateDot state={state} />
      {children}
    </span>
  );
}
