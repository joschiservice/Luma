import { m } from '@luma/i18n/messages';
import { Fragment, useId } from 'react';

import {
  type ListShortcut,
  listShortcutKeys,
  listShortcuts,
} from '../../lib/list-keyboard';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './dialog';
import { Kbd } from './kbd';

/** One command in shortcut help: alternative key sequences, each pressed together. */
interface ShortcutEntry {
  keys: readonly (readonly string[])[];
  label: string;
}

/** A titled group of shortcuts, such as "Lists". */
export interface ShortcutGroup {
  title: string;
  shortcuts: readonly ShortcutEntry[];
}

const listLabels: Record<ListShortcut, () => string> = {
  next: m.ui_shortcut_next,
  previous: m.ui_shortcut_previous,
  open: m.ui_shortcut_open,
  preview: m.ui_shortcut_preview,
  'toggle-selection': m.ui_shortcut_toggle_selection,
  'extend-selection': m.ui_shortcut_extend_selection,
  escape: m.ui_shortcut_escape,
  search: m.ui_shortcut_search,
  filter: m.ui_shortcut_filter,
  help: m.ui_shortcut_help,
};

/**
 * The list shortcuts as a help group. Pass `only` to list the commands a page handles, so help
 * never promises a key that does nothing. Call while rendering; labels follow the language.
 */
export function listShortcutGroup(
  only: readonly ListShortcut[] = listShortcuts,
): ShortcutGroup {
  return {
    title: m.ui_shortcuts_lists(),
    shortcuts: only.map((command) => ({
      keys: listShortcutKeys[command],
      label: listLabels[command](),
    })),
  };
}

/**
 * Lists keyboard shortcuts in a dialog, opened with `?`. Each command shows its keys; the
 * caller decides which groups apply to the page.
 */
export function ShortcutHelp({
  open,
  onOpenChange,
  groups,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: readonly ShortcutGroup[];
}) {
  const id = useId();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="ui-shortcut-help">
        <DialogHeader>
          <DialogTitle>{m.ui_shortcuts_title()}</DialogTitle>
          <DialogDescription>{m.ui_shortcuts_description()}</DialogDescription>
        </DialogHeader>
        {groups.map((group, index) => (
          <section
            key={group.title}
            className="ui-shortcut-group"
            aria-labelledby={`${id}-${index}`}
          >
            <h3 id={`${id}-${index}`}>{group.title}</h3>
            <dl>
              {group.shortcuts.map((shortcut) => (
                <div key={shortcut.label} className="ui-shortcut">
                  <dt>{shortcut.label}</dt>
                  <dd>
                    {shortcut.keys.map((combo, alternative) => (
                      <Fragment key={combo.join('+')}>
                        {alternative ? (
                          <span className="ui-shortcut-or">
                            {m.ui_shortcuts_or()}
                          </span>
                        ) : null}
                        <span className="ui-shortcut-keys">
                          {combo.map((key) => (
                            <Kbd key={key}>{key}</Kbd>
                          ))}
                        </span>
                      </Fragment>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  );
}
