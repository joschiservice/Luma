import { Menu } from '@base-ui/react/menu';
import {
  BookOpen,
  Check,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Sun,
} from 'lucide-react';
import type { ReactElement } from 'react';

import { initialsOf } from './workspace-switcher';

export type ThemeChoice = 'system' | 'light' | 'dark';

const themes = [
  { value: 'system', label: 'System', Icon: Monitor },
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
] as const;

/**
 * Shows the signed-in person with their appearance, settings, documentation and
 * sign-out actions. The host stores the theme and supplies the navigation links.
 */
export function WorkspaceAccountMenu({
  name,
  email,
  theme,
  onThemeChange,
  settingsLink,
  docsLink,
}: {
  name: string;
  email?: string | undefined;
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
  settingsLink: ReactElement;
  docsLink: ReactElement;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        className="account-trigger"
        aria-label={`${name}. Open account menu`}
      >
        <span className="account-avatar" aria-hidden="true">
          {initialsOf(name, 'U')}
        </span>
        <span className="account-identity">
          <strong title={name}>{name}</strong>
          {email ? <span title={email}>{email}</span> : null}
        </span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          side="top"
          align="start"
          sideOffset={6}
          className="z-50"
        >
          <Menu.Popup className="lu-popover account-menu">
            <div className="account-menu-person">
              <strong>{name}</strong>
              {email ? <span>{email}</span> : null}
            </div>
            <Menu.Separator className="workspace-menu-separator" />
            <Menu.Group>
              <Menu.GroupLabel className="workspace-menu-label">
                Appearance
              </Menu.GroupLabel>
              <Menu.RadioGroup
                value={theme}
                onValueChange={(value) => onThemeChange(value as ThemeChoice)}
              >
                {themes.map(({ value, label, Icon }) => (
                  <Menu.RadioItem
                    key={value}
                    value={value}
                    className="lu-menu-item"
                    closeOnClick={false}
                  >
                    <Icon size={15} aria-hidden="true" />
                    <span className="account-menu-grow">{label}</span>
                    <Menu.RadioItemIndicator className="account-menu-check">
                      <Check size={14} aria-hidden="true" />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
            <Menu.Separator className="workspace-menu-separator" />
            <Menu.Item render={settingsLink} className="lu-menu-item">
              <Settings size={15} aria-hidden="true" />
              Settings
            </Menu.Item>
            <Menu.Item render={docsLink} className="lu-menu-item">
              <BookOpen size={15} aria-hidden="true" />
              Documentation
            </Menu.Item>
            <Menu.Separator className="workspace-menu-separator" />
            <Menu.Item render={<a href="/sign-out" />} className="lu-menu-item">
              <LogOut size={15} aria-hidden="true" />
              Sign out
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
