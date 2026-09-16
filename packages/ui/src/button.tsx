import type { ComponentProps } from 'react';
import './button.css';

export type ButtonProps = ComponentProps<'button'> & {
  pending?: boolean;
};

/** A native button; callers own actions, data and pending state. */
export function Button({
  children,
  className,
  disabled,
  pending = false,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={['luma-button', className].filter(Boolean).join(' ')}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
    >
      {pending ? (
        <span className="luma-button__spinner" aria-hidden="true" />
      ) : null}
      {children}
    </button>
  );
}
