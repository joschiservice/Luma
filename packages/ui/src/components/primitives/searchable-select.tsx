import { Combobox } from '@base-ui/react/combobox';
import { Check, Search } from 'lucide-react';

import type { SelectOption } from './select';

/** Chooses one option from a long list by typing part of its label. */
export function SearchableSelect({
  options,
  value,
  disabled,
  onValueChange,
  'aria-labelledby': ariaLabelledBy,
}: {
  options: readonly SelectOption[];
  value: string;
  disabled?: boolean;
  onValueChange: (value: string | null) => void;
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
              No matching timezones
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
