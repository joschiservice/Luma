import { useRef } from 'react';

import type { SectionNavigationItem } from '../primitives/section-navigation';
import { Select } from '../primitives/select';

/** Moves focus to a section after the menu has closed and released its focus management. */
export function IssueSectionSelect({
  value,
  options,
  onNavigate,
  label,
}: {
  value: string;
  options: readonly SectionNavigationItem[];
  onNavigate: (section: string) => void;
  label: string;
}) {
  const pending = useRef<string | null>(null);

  return (
    <Select
      aria-label={label}
      value={value}
      options={options}
      onValueChange={(next) => {
        pending.current = next;
      }}
      onOpenChangeComplete={(open) => {
        if (!open && pending.current) {
          const section = pending.current;
          pending.current = null;
          onNavigate(section);
        }
      }}
    />
  );
}
