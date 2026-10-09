import { Combobox } from '@base-ui/react/combobox';
import { m } from '@luma/i18n/messages';
import { cn } from '@luma/ui/lib/utils';
import { ChevronDown, Search, X } from 'lucide-react';
import { useState } from 'react';

import { useSmallScreen } from '../../lib/use-small-screen';
import { Button, buttonVariants } from './button';

export interface PersonOption {
  id: string;
  /** The name shown first, such as "Alex Morgan" or "You". */
  name: string;
  /** A second line that also matches searches, usually the email address. */
  detail?: string | undefined;
}

/** Text that a search matches against: the name and the second line. */
const searchText = (person: PersonOption) =>
  person.detail ? `${person.name} ${person.detail}` : person.name;

/**
 * Picks one person from a workspace-sized list by typing part of their name or email. The
 * trigger reads `label`, such as "Assign to…"; `title` heads the popup and names its list.
 * Matching ignores case and accents. At most `limit` matches are drawn, with a prompt to keep
 * typing when more match, so long lists stay quick. `people` keeps its order, so callers put
 * likely choices such as the reader first. Choosing a person calls `onSelect` and closes the
 * popup; the picker does not keep a selected value. Small screens get a modal bottom sheet.
 */
export function PersonPicker({
  people,
  label,
  title,
  onSelect,
  disabled = false,
  limit = 50,
  className,
}: {
  people: readonly PersonOption[];
  label: string;
  title: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
  limit?: number;
  className?: string | undefined;
}) {
  const mobile = useSmallScreen();
  const { contains } = Combobox.useFilter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const matches = query.trim()
    ? people.filter((person) => contains(person, query.trim(), searchText))
    : people;
  const shown = matches.length > limit ? matches.slice(0, limit) : matches;

  return (
    <Combobox.Root<PersonOption>
      items={people}
      filteredItems={shown}
      value={null}
      onValueChange={(person) => {
        if (person) onSelect(person.id);
      }}
      itemToStringLabel={(person) => person.name}
      isItemEqualToValue={(item, value) => item.id === value.id}
      inputValue={query}
      onInputValueChange={setQuery}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
      modal={mobile}
      autoHighlight
    >
      {/* A combobox doesn't take its name from its text, so the label is repeated. */}
      <Combobox.Trigger
        aria-label={label}
        className={cn(
          buttonVariants({ variant: 'outline', size: 'sm' }),
          'person-picker-trigger',
          className,
        )}
      >
        {label}
        <ChevronDown size={14} aria-hidden="true" />
      </Combobox.Trigger>
      <Combobox.Portal>
        {mobile && <Combobox.Backdrop className="ui-picker-backdrop" />}
        <Combobox.Positioner
          sideOffset={6}
          align="start"
          className="ui-picker-positioner"
        >
          <Combobox.Popup className="ui-picker-popup" aria-label={title}>
            <div className="ui-picker-heading">
              <h2>{title}</h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label={m.common_close()}
                onClick={() => setOpen(false)}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
            <div className="searchable-select">
              <Combobox.Input
                aria-label={m.ui_person_picker_search_label()}
                placeholder={m.ui_person_picker_search_placeholder()}
                className="searchable-select-input"
              />
              <Search size={15} aria-hidden="true" />
            </div>
            <Combobox.Empty className="searchable-select-empty">
              {m.ui_person_picker_no_matches()}
            </Combobox.Empty>
            <Combobox.List
              aria-label={title}
              className="searchable-select-list person-picker-list"
            >
              {(person: PersonOption) => (
                <Combobox.Item
                  key={person.id}
                  value={person}
                  className="searchable-select-option person-picker-option"
                >
                  <span>{person.name}</span>
                  {person.detail ? <small>{person.detail}</small> : null}
                </Combobox.Item>
              )}
            </Combobox.List>
            {matches.length > shown.length ? (
              <p className="person-picker-more">
                {m.ui_person_picker_more({
                  shown: shown.length,
                  total: matches.length,
                })}
              </p>
            ) : null}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
