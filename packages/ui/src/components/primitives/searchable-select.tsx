import { Combobox } from '@base-ui/react/combobox';
import { m } from '@luma/i18n/messages';
import { Check, Search } from 'lucide-react';

import type { SelectOption } from './select';

/**
 * Chooses one option from a long list by typing part of its label. `emptyLabel` replaces the
 * generic text shown when nothing matches, such as "No matching timezones".
 */
export function SearchableSelect({
  options,
  value,
  disabled,
  onValueChange,
  emptyLabel,
  'aria-labelledby': ariaLabelledBy,
}: {
  options: readonly SelectOption[];
  value: string;
  disabled?: boolean;
  onValueChange: (value: string | null) => void;
  emptyLabel?: string | undefined;
  'aria-labelledby': string;
}) {
  return (
    <Combobox.Root
      items={options}
      value={options.find((option) => option.value === value) ?? null}
      itemToStringLabel={(option) => option.label}
      itemToStringValue={(option) => option.value}
      onValueChange={(option) => onValueChange(option?.value ?? null)}
      autoHighlight
    >
      <div className="searchable-select">
        <Combobox.Input
          aria-labelledby={ariaLabelledBy}
          disabled={disabled}
          className="searchable-select-input"
        />
        <Search size={15} aria-hidden="true" />
      </div>
      <Combobox.Portal>
        <Combobox.Positioner
          sideOffset={6}
          className="searchable-select-positioner"
        >
          <Combobox.Popup className="searchable-select-popup">
            <Combobox.Empty className="searchable-select-empty">
              {emptyLabel ?? m.ui_select_no_matches()}
            </Combobox.Empty>
            <Combobox.List className="searchable-select-list">
              {(option: SelectOption) => (
                <Combobox.Item
                  key={option.value}
                  value={option}
                  className="searchable-select-option"
                >
                  {option.label}
                  <Combobox.ItemIndicator>
                    <Check size={14} aria-hidden="true" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
