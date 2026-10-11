import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { onlineManager, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, useSyncExternalStore } from 'react';

import { IdentityError } from '../../kit/identity/data';
import { settingsApi } from '../../kit/settings/data';

const subscribe = (changed: () => void) => onlineManager.subscribe(changed);

/** Subscribes to connectivity without queuing writes while offline. */
export function useSettingsOnline() {
  return useSyncExternalStore(
    subscribe,
    () => onlineManager.isOnline(),
    () => true,
  );
}

/** Reconciles uncertain writes before allowing another command; retries retain their identity. */
export function useSettingsCommand(organizationId: string) {
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>(null);
  const uncertain = useRef<{
    id: string;
    operation: (id: string) => Promise<unknown>;
    success: string;
  } | null>(null);
  const [needsCheck, setNeedsCheck] = useState(false);

  async function refresh() {
    await Promise.all([
      client.invalidateQueries({
        queryKey: ['private', 'organization', organizationId],
      }),
      client.invalidateQueries({ queryKey: ['private', 'organizations'] }),
    ]);
  }

  async function run(
    operation: (id: string) => Promise<unknown>,
    success = m.settings_command_saved(),
  ) {
    if (pending || uncertain.current) return;
    const command = { id: crypto.randomUUID(), operation, success };
    setPending(true);
    setError(null);
    setMessage('');
    try {
      await operation(command.id);
      setMessage(success);
      await refresh();
    } catch (error) {
      setError(error);
      if (!(error instanceof IdentityError) || error.status >= 500) {
        uncertain.current = command;
        setNeedsCheck(true);
      }
      await refresh();
    } finally {
      setPending(false);
    }
  }

  async function reconcile() {
    const command = uncertain.current;
    if (!command || pending) return;
    setPending(true);
    setError(null);
    try {
      await settingsApi.settings.receipt({
        params: { organizationId, commandId: command.id },
      });
      await command.operation(command.id);
      uncertain.current = null;
      setNeedsCheck(false);
      setMessage(command.success);
      await refresh();
    } catch (error) {
      if (error instanceof IdentityError && error.status < 500) {
        uncertain.current = null;
        setNeedsCheck(false);
      }
      setError(error);
    } finally {
      setPending(false);
    }
  }

  return {
    run,
    pending,
    message,
    error,
    needsCheck,
    reconcile,
    locked: pending || needsCheck,
  };
}

/** Announces command progress and offers safe recovery for an uncertain response. */
export function CommandFeedback({
  command,
}: {
  command: ReturnType<typeof useSettingsCommand>;
}) {
  return (
    <div className="settings-feedback" aria-live="polite">
      {command.pending ? (
        <span role="status">{m.settings_command_saving()}</span>
      ) : null}
      {command.message ? (
        <span className="settings-saved" role="status">
          {command.message}
        </span>
      ) : null}
      {command.error ? (
        <Alert tone="danger" role="alert">
          {command.needsCheck
            ? m.settings_command_uncertain()
            : command.error instanceof Error
              ? command.error.message
              : m.common_save_failed()}
        </Alert>
      ) : null}
      {command.needsCheck ? (
        <Button
          variant="outline"
          disabled={command.pending}
          onClick={() => void command.reconcile()}
        >
          {m.settings_command_check_status()}
        </Button>
      ) : null}
    </div>
  );
}
