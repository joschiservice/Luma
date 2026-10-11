import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Input } from '@luma/ui/components/primitives/input';
import { useForm } from '@tanstack/react-form';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { auth, sessionKey } from '../../kit/identity/data';
import { securityActivityKey } from './security-activity';
import { accountSessionsKey } from './sessions';

/** Changes the account password with current-password proof and optional session revocation. */
export function PasswordSettings({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');

  return (
    <div className="settings-panel">
      <div className="settings-panel-heading">
        <div>
          <h3>{m.settings_security_password_title()}</h3>
          <p>{m.settings_security_password_description()}</p>
        </div>
      </div>
      <div className="settings-security-row">
        <Button disabled={disabled} onClick={() => setOpen(true)}>
          {m.settings_security_password_change()}
        </Button>
      </div>
      {notice ? (
        <p className="settings-note settings-security-row" role="status">
          {notice}
        </p>
      ) : null}
      {open ? (
        <PasswordDialog
          onClose={(changed) => {
            setOpen(false);
            if (changed) setNotice(m.settings_security_password_changed());
          }}
        />
      ) : null}
    </div>
  );
}

function PasswordDialog({ onClose }: { onClose: (changed?: boolean) => void }) {
  const client = useQueryClient();
  const id = useId();
  const [error, setError] = useState('');
  const form = useForm({
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      revokeOtherSessions: false,
    },
    onSubmit: async ({ value }) => {
      setError('');
      try {
        const result = await auth.changePassword(value);
        if (result.error) {
          setError(
            result.error.code === 'INVALID_PASSWORD'
              ? m.settings_security_password_wrong()
              : result.error.code === 'SESSION_NOT_FRESH'
                ? m.settings_security_password_not_fresh()
                : m.settings_security_password_failed(),
          );

          return;
        }
        await Promise.all(
          [sessionKey, accountSessionsKey, securityActivityKey].map(
            (queryKey) => client.invalidateQueries({ queryKey }),
          ),
        );
        onClose(true);
      } catch {
        setError(m.settings_security_unreachable());
      } finally {
        form.setFieldValue('currentPassword', '');
        form.setFieldValue('newPassword', '');
      }
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !form.state.isSubmitting) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{m.settings_security_password_change()}</DialogTitle>
        <DialogDescription>
          {m.settings_security_password_description()}
        </DialogDescription>
        <form
          className="settings-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          {(['currentPassword', 'newPassword'] as const).map((name) => (
            <form.Field key={name} name={name}>
              {(field) => (
                <>
                  <label htmlFor={`${id}-${name}`}>
                    {name === 'currentPassword'
                      ? m.settings_security_password_current()
                      : m.settings_security_password_new()}
                  </label>
                  <Input
                    id={`${id}-${name}`}
                    type="password"
                    autoComplete={
                      name === 'currentPassword'
                        ? 'current-password'
                        : 'new-password'
                    }
                    required
                    minLength={name === 'newPassword' ? 12 : 1}
                    maxLength={128}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                  />
                </>
              )}
            </form.Field>
          ))}
          <form.Field name="revokeOtherSessions">
            {(field) => (
              <label>
                <input
                  type="checkbox"
                  checked={field.state.value}
                  onChange={(event) => field.handleChange(event.target.checked)}
                />{' '}
                {m.settings_security_password_revoke()}
              </label>
            )}
          </form.Field>
          {error ? (
            <Alert tone="danger" role="alert">
              {error}
            </Alert>
          ) : null}
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(pending) => (
              <div className="settings-dialog-actions">
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => onClose()}
                >
                  {m.common_cancel()}
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending
                    ? m.settings_security_checking()
                    : m.settings_security_password_change()}
                </Button>
              </div>
            )}
          </form.Subscribe>
        </form>
      </DialogContent>
    </Dialog>
  );
}
