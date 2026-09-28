import { Switch as SwitchPrimitive } from '@base-ui/react/switch';

import { cn } from '../../lib/utils';

/** Toggles a labeled binary preference with native keyboard and focus behavior. */
export function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      {...props}
      className={cn(
        'inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full bg-[color-mix(in_srgb,var(--foreground)_16%,transparent)] p-0.5 outline-none transition-colors duration-150 data-[checked]:bg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
        className,
      )}
    >
      <SwitchPrimitive.Thumb className="size-3.5 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-transform duration-150 ease-[var(--ease-standard)] data-[checked]:translate-x-3.5 motion-reduce:transition-none" />
    </SwitchPrimitive.Root>
  );
}
