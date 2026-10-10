import { m } from '@luma/i18n/messages';
import { RefreshCw } from 'lucide-react';

import { useSlowRequest } from '../../lib/use-slow-request';
import { Button, type ButtonProps } from './button';
import { Tooltip } from './tooltip';

/**
 * Reloads a view on demand as an icon button named by `label` (default "Refresh"), which is also
 * its tooltip; `detail`, such as when the view was last updated, adds a second tooltip line. It
 * stays usable while a read is in flight, because live views read often in the background; the
 * icon spins only once a read has run longer than expected. Disable it only when reading can't
 * work, such as offline. Use a labelled button instead when reloading is the way out of an error.
 */
export function RefreshButton({
  refreshing = false,
  label = m.common_refresh(),
  detail,
  variant = 'outline',
  size = 'icon',
  ...props
}: Omit<ButtonProps, 'children' | 'size'> & {
  refreshing?: boolean;
  label?: string;
  detail?: string | undefined;
  size?: 'icon' | 'icon-sm';
}) {
  const slow = useSlowRequest(refreshing);

  return (
    <Tooltip
      content={
        detail ? (
          <>
            {label}
            <span className="lu-tooltip-detail">{detail}</span>
          </>
        ) : (
          label
        )
      }
    >
      <Button
        {...props}
        variant={variant}
        size={size}
        aria-label={label}
        aria-busy={slow || undefined}
      >
        <RefreshCw
          aria-hidden="true"
          className={
            slow ? 'animate-spin motion-reduce:animate-none' : undefined
          }
        />
      </Button>
    </Tooltip>
  );
}
