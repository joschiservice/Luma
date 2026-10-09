import { RefreshCw } from 'lucide-react';

import { useSlowRequest } from '../../lib/use-slow-request';
import { Button, type ButtonProps } from './button';

/**
 * Reloads a view on demand. It stays usable while a read is in flight, because live views read
 * often in the background; the icon spins only once a read has run longer than expected.
 * `children` is the visible label.
 */
export function RefreshButton({
  refreshing = false,
  variant = 'outline',
  children,
  ...props
}: Omit<ButtonProps, 'disabled'> & { refreshing?: boolean }) {
  const slow = useSlowRequest(refreshing);

  return (
    <Button {...props} variant={variant} aria-busy={slow || undefined}>
      <RefreshCw
        size={14}
        aria-hidden="true"
        className={slow ? 'animate-spin motion-reduce:animate-none' : undefined}
      />
      {children}
    </Button>
  );
}
