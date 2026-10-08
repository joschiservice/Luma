import { m } from '@luma/i18n/messages';
import { useId } from 'react';

import { cn } from '../../lib/utils';

type MarkProps = { className?: string; title?: string };

/**
 * Draws Luma's provisional State Shift mark: one form shown in two related states.
 * Pass a title when the mark is the only accessible name; otherwise it is decorative.
 */
export function LumaMark({
  className,
  title,
  tone = 'color',
}: MarkProps & { tone?: 'color' | 'mono' }) {
  const id = useId().replace(/:/g, '');
  const maskId = `luma-mask-${id}`;
  const gradientId = `luma-gradient-${id}`;

  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={cn('lu-mark', className)}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="32"
          height="32"
        >
          <rect width="32" height="32" fill="white" />
          <rect x="9.5" y="9.5" width="20" height="20" rx="7" fill="black" />
        </mask>
        <linearGradient
          id={gradientId}
          x1="12"
          y1="12"
          x2="28"
          y2="28"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#54A3FF" />
          <stop offset="1" stopColor="#316BFF" />
        </linearGradient>
      </defs>
      <rect
        x="4"
        y="4"
        width="16"
        height="16"
        rx="5"
        stroke="currentColor"
        strokeWidth={3}
        strokeOpacity={tone === 'color' ? 0.55 : 1}
        mask={`url(#${maskId})`}
      />
      <rect
        x="12"
        y="12"
        width="16"
        height="16"
        rx="5"
        fill={tone === 'color' ? `url(#${gradientId})` : 'currentColor'}
      />
    </svg>
  );
}

/** Draws Auren's provisional Open Interlock mark for company attribution. */
export function AurenMark({ className, title }: MarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={3.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('lu-mark', className)}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <path d="M18 7H12A6 6 0 0 0 12 19H18" />
      <path d="M14 13H20A6 6 0 0 1 20 25H14" />
    </svg>
  );
}

/** Shows the Luma lockup. Add "by Auren" only where provenance helps a new reader. */
export function LumaLockup({
  className,
  byAuren = false,
  size = 'md',
}: {
  className?: string;
  byAuren?: boolean;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <span className={cn('lu-lockup', className)} data-size={size}>
      <LumaMark />
      <span className="lu-lockup-name">Luma</span>
      {byAuren ? (
        <span className="lu-lockup-by">{m.ui_brand_by_auren()}</span>
      ) : null}
    </span>
  );
}
