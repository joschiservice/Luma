import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';

import { errorMessage } from '../api';

/** Holds a section's place while its first data loads. */
export function Loading({ label }: { label: string }) {
  return (
    <div className="sim-loading" role="status" aria-label={label}>
      <span className="lu-skeleton" />
      <span className="lu-skeleton" />
      <span className="lu-skeleton" />
    </div>
  );
}

/**
 * Explains why a section could not load. Earlier values are not shown, so stale numbers are
 * never mistaken for current ones.
 */
export function LoadError({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <Alert tone="danger" role="alert">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{errorMessage(error)}</p>
        {onRetry ? (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
