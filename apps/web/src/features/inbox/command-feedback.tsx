import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';

/**
 * Shows why a command failed. An unknown outcome offers a retry that repeats the same request, so
 * the server applies it at most once.
 */
export function CommandFeedback({
  command,
}: {
  command: {
    errorText: string | undefined;
    uncertain: boolean;
    isPending: boolean;
    retry: () => void;
  };
}) {
  if (!command.errorText) return null;

  return (
    <Alert
      tone={command.uncertain ? 'warning' : 'danger'}
      role="alert"
      className="messaging-feedback"
    >
      {command.errorText}
      {command.uncertain ? (
        <>
          {' '}
          <Button
            size="sm"
            variant="outline"
            disabled={command.isPending}
            onClick={command.retry}
          >
            {m.messaging_retry_same()}
          </Button>
        </>
      ) : null}
    </Alert>
  );
}
