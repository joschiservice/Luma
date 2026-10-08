import { Alert, AlertDescription } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Spinner } from '@luma/ui/components/primitives/spinner';

import { errorMessage } from './api';

/** Announces a pending read without implying an empty result. */
export function Loading({ children }: { children: string }) {
  return (
    <p role="status" className="staff-actions">
      <Spinner />
      {children}
    </p>
  );
}

/** Shows a failed read with an explicit retry action. */
export function Failure({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  return (
    <Alert tone="danger" role="alert">
      <AlertDescription>{errorMessage(error)}</AlertDescription>
      {retry ? (
        <Button variant="outline" size="sm" onClick={retry}>
          Try again
        </Button>
      ) : null}
    </Alert>
  );
}
