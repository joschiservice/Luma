import { Progress as ProgressPrimitive } from '@base-ui/react/progress';

import { cn } from '../../lib/utils';

/**
 * Shows how far a piece of work has come. Pass `null` when the total is unknown; the bar then
 * moves without implying a percentage, and stays still for readers who prefer reduced motion.
 * Always name it with `label`, such as "Order history import".
 */
export function Progress({
  value,
  max = 100,
  label,
  valueText,
  className,
}: {
  value: number | null;
  max?: number;
  label: string;
  /** Spoken value, such as "240 of about 1,200 orders". */
  valueText?: string;
  className?: string;
}) {
  return (
    <ProgressPrimitive.Root
      value={value === null ? null : Math.min(max, Math.max(0, value))}
      max={max}
      aria-label={label}
      {...(valueText ? { getAriaValueText: () => valueText } : {})}
      className={cn('lu-progress', className)}
    >
      <ProgressPrimitive.Track className="lu-progress-track">
        <ProgressPrimitive.Indicator className="lu-progress-indicator" />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}
