import { Menu } from '@base-ui/react/menu';
import { localeNames } from '@luma/i18n/locales';
import { m } from '@luma/i18n/messages';
import { getLocale, type Locale, locales, setLocale } from '@luma/i18n/runtime';
import {
  BookOpen,
  Check,
  Languages,
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
  { value: 'system', label: m.ui_account_theme_system, Icon: Monitor },
  { value: 'light', label: m.ui_account_theme_light, Icon: Sun },
  { value: 'dark', label: m.ui_account_theme_dark, Icon: Moon },
] as const;

/**
 * Shows the signed-in person with their appearance, language, settings, documentation and
 * sign-out actions. The host stores the theme and supplies the navigation links. Choosing
 * another language stores it in a cookie and reloads the page, so server-rendered text and
 * formatting switch together. `exit` replaces sign-out, for example to end a support view.
 */
export function WorkspaceAccountMenu({
  name,
  email,
  theme,
  onThemeChange,
  settingsLink,
  docsLink,
  exit,
}: {
  name: string;
  email?: string | undefined;
  theme: ThemeChoice;
  onThemeChange: (theme: ThemeChoice) => void;
  settingsLink: ReactElement;
  docsLink: ReactElement;
  exit?: { label: string; onSelect: () => void } | undefined;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        className="account-trigger"
        aria-label={m.ui_account_menu_open({ name })}
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
                {m.ui_account_appearance()}
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
                    <span className="account-menu-grow">{label()}</span>
                    <Menu.RadioItemIndicator className="account-menu-check">
                      <Check size={14} aria-hidden="true" />
                    </Menu.RadioItemIndicator>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
            <Menu.Separator className="workspace-menu-separator" />
            <Menu.Group>
              <Menu.GroupLabel className="workspace-menu-label">
                {m.ui_language_label()}
              </Menu.GroupLabel>
              <Menu.RadioGroup
                value={getLocale()}
                onValueChange={(value: Locale) => {
                  if (value !== getLocale()) void setLocale(value);
                }}
              >
                {locales.map((locale) => (
                  <Menu.RadioItem
                    key={locale}
                    value={locale}
                    lang={locale}
                    className="lu-menu-item"
                  >
                    <Languages size={15} aria-hidden="true" />
                    <span className="account-menu-grow">
                      {localeNames[locale]}
                    </span>
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
              {m.ui_account_settings()}
            </Menu.Item>
            <Menu.Item render={docsLink} className="lu-menu-item">
              <BookOpen size={15} aria-hidden="true" />
              {m.ui_account_documentation()}
            </Menu.Item>
            <Menu.Separator className="workspace-menu-separator" />
            {exit ? (
              <Menu.Item onClick={exit.onSelect} className="lu-menu-item">
                <LogOut size={15} aria-hidden="true" />
                {exit.label}
              </Menu.Item>
            ) : (
              <Menu.Item
                render={<a href="/sign-out" />}
                className="lu-menu-item"
              >
                <LogOut size={15} aria-hidden="true" />
                {m.ui_account_sign_out()}
              </Menu.Item>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
