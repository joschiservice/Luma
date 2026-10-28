import './confirm-action.css';

import { m } from '@luma/i18n/messages';
import {
  Button,
  type ButtonProps,
} from '@luma/ui/components/primitives/button';
import { type ReactNode, useEffect, useRef, useState } from 'react';

/**
 * A destructive action that asks once before it runs. The trigger turns into the question with
 * a confirm button and a dismiss button; focus starts on dismiss so Enter doesn't confirm by
 * accident, Escape dismisses, and dismissing returns focus to the trigger. `onConfirm` runs
 * only after the explicit confirm click.
 */
export function ConfirmAction({
  children,
  prompt,
  confirmLabel,
  dismissLabel = m.common_cancel(),
  onConfirm,
  disabled = false,
  variant = 'ghost',
}: {
  children: ReactNode;
  prompt: string;
  confirmLabel: string;
  dismissLabel?: string;
  onConfirm: () => void;
  disabled?: boolean;
  variant?: ButtonProps['variant'];
}) {
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (confirming || !returnFocus.current) return;
    returnFocus.current = false;
    trigger.current?.focus();
  }, [confirming]);

  function dismiss() {
    returnFocus.current = true;
    setConfirming(false);
  }

  if (confirming)
    return (
      <span
        className="confirm-action"
        role="group"
        aria-label={prompt}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          // Inside a dialog, Escape answers the question instead of closing the dialog.
          event.stopPropagation();
          dismiss();
        }}
      >
        <span className="confirm-action-prompt">{prompt}</span>
        <Button
          variant="destructive"
          disabled={disabled}
          onClick={() => {
            setConfirming(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
        <Button variant="ghost" autoFocus onClick={dismiss}>
          {dismissLabel}
        </Button>
      </span>
    );

  return (
    <Button
      ref={trigger}
      variant={variant}
      disabled={disabled}
      onClick={() => setConfirming(true)}
    >
      {children}
    </Button>
  );
}
