import type { HomeModule, HomeModuleId, PinnedPage } from '@luma/api-contract';
import { homeModuleIds } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { Switch } from '@luma/ui/components/primitives/switch';
import { LanguageSelect } from '@luma/ui/components/workspace/language-select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  Monitor,
  Moon,
  PinOff,
  RotateCcw,
  Sun,
} from 'lucide-react';
import { useId, useState } from 'react';

import { resetAllCollectionStates } from '../../kit/collections/data';
import {
  defaultHome,
  homeModules,
  moveModule,
} from '../../kit/home/preferences';
import { useWorkspaceLayout } from '../../kit/layout/data';
import { setSidebarCollapsed, useSidebarCollapsed } from '../../lib/sidebar';
import {
  setThemePreference,
  type ThemePreference,
  useThemePreference,
} from '../../lib/theme';
import { adaptiveAvailabilityOptions } from '../adaptive/data';
import { SectionHeading } from './section-heading';

const themes: {
  value: ThemePreference;
  label: () => string;
  description: () => string;
  Icon: typeof Sun;
}[] = [
  {
    value: 'system',
    label: m.settings_theme_system,
    description: m.settings_theme_system_description,
    Icon: Monitor,
  },
  {
    value: 'light',
    label: m.settings_theme_light,
    description: m.settings_theme_light_description,
    Icon: Sun,
  },
  {
    value: 'dark',
    label: m.settings_theme_dark,
    description: m.settings_theme_dark_description,
    Icon: Moon,
  },
];

/** Lets the reader choose the interface language, theme and default sidebar width on this device. */
export function AppearanceSettings() {
  const theme = useThemePreference();
  const collapsed = useSidebarCollapsed();
  const titleId = useId();
  const descriptionId = useId();
  const languageId = useId();
  const languageDescriptionId = useId();

  return (
    <section>
      <SectionHeading
        title={m.settings_appearance_title()}
        description={m.settings_appearance_description()}
        badge={m.settings_badge_this_device()}
      />
      <div className="settings-panel">
        <div className="settings-preference">
          <span>
            <strong id={languageId}>{m.settings_language_title()}</strong>
            <span id={languageDescriptionId}>
              {m.settings_language_description()}
            </span>
          </span>
          <LanguageSelect
            aria-labelledby={languageId}
            aria-describedby={languageDescriptionId}
          />
        </div>
        <fieldset className="settings-themes">
          <legend>{m.settings_theme_legend()}</legend>
          <div className="settings-theme-options">
            {themes.map(({ value, label, description, Icon }) => (
              <label key={value} className="settings-theme" data-theme={value}>
                <input
                  type="radio"
                  name="theme"
                  value={value}
                  checked={theme === value}
                  onChange={() => setThemePreference(value)}
                />
                <span className="settings-theme-preview" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="settings-theme-label">
                  <Icon size={14} aria-hidden="true" />
                  <strong>{label()}</strong>
                </span>
                <span className="settings-theme-description">
                  {description()}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="settings-preference">
          <span>
            <strong id={titleId}>{m.settings_sidebar_collapse_title()}</strong>
            <span id={descriptionId}>
              {m.settings_sidebar_collapse_description()}
            </span>
          </span>
          <Switch
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            checked={collapsed}
            onCheckedChange={setSidebarCollapsed}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * Manages the reader's Home modules and sidebar pins for this workspace. Changes save
 * immediately and apply only to the reader.
 */
export function HomeSidebarSettings({
  organizationId,
}: {
  organizationId: string;
}) {
  const workspace = useWorkspaceLayout(organizationId);
  const adaptive = useQuery(adaptiveAvailabilityOptions(organizationId));
  const modules = workspace.layout?.home ?? defaultHome;
  const pinned = workspace.layout?.pinned ?? [];
  const saveHome = (home: HomeModule[]) => workspace.save({ home });
  const savePins = (next: PinnedPage[]) => workspace.save({ pinned: next });
  const ordered: HomeModuleId[] = [
    ...modules.map((module) => module.id),
    ...homeModuleIds.filter(
      (id) =>
        (id !== 'saved-views' || adaptive.data?.views === true) &&
        !modules.some((item) => item.id === id),
    ),
  ];

  return (
    <section>
      <SectionHeading
        title={m.settings_home_title()}
        description={m.settings_home_description()}
        badge={m.settings_badge_personal()}
      />
      {workspace.conflict ? (
        <Alert tone="warning" role="status">
          {m.settings_home_conflict()}
        </Alert>
      ) : workspace.saveFailed ? (
        <Alert tone="danger" role="alert">
          {m.settings_home_save_failed()}
        </Alert>
      ) : null}
      <div className="settings-panel">
        <div className="settings-panel-heading">
          <div>
            <h3>{m.settings_home_modules_title()}</h3>
            <p>{m.settings_home_modules_description()}</p>
          </div>
          <Button
            variant="ghost"
            disabled={!workspace.layout || workspace.layout.home === null}
            onClick={() => workspace.save({ home: null })}
          >
            <RotateCcw aria-hidden="true" />
            {m.settings_home_reset()}
          </Button>
        </div>
        <ul
          className="settings-modules"
          aria-label={m.settings_home_modules_title()}
        >
          {ordered.map((id) => {
            const info = homeModules[id];
            const module = modules.find((item) => item.id === id);
            const index = modules.findIndex((item) => item.id === id);

            return (
              <li key={id} data-hidden={module ? undefined : 'true'}>
                <info.Icon size={16} aria-hidden="true" />
                <span className="settings-module-copy">
                  <strong>{info.title}</strong>
                  <span>{info.description}</span>
                </span>
                {module ? (
                  <>
                    <Select<HomeModule['size']>
                      aria-label={m.settings_home_module_width({
                        module: info.title,
                      })}
                      className="settings-module-size"
                      value={module.size}
                      onValueChange={(size) => {
                        if (size)
                          saveHome(
                            modules.map((item) =>
                              item.id === id ? { ...item, size } : item,
                            ),
                          );
                      }}
                      options={[
                        { value: 'half', label: m.settings_home_width_half() },
                        { value: 'full', label: m.settings_home_width_full() },
                      ]}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={m.settings_home_module_earlier({
                        module: info.title,
                      })}
                      disabled={index === 0}
                      onClick={() => saveHome(moveModule(modules, id, -1))}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={m.settings_home_module_later({
                        module: info.title,
                      })}
                      disabled={index === modules.length - 1}
                      onClick={() => saveHome(moveModule(modules, id, 1))}
                    >
                      <ArrowDown />
                    </Button>
                  </>
                ) : null}
                <Switch
                  aria-label={m.settings_home_module_show({
                    module: info.title,
                  })}
                  checked={Boolean(module)}
                  disabled={!workspace.layout}
                  onCheckedChange={(checked) =>
                    saveHome(
                      checked
                        ? [...modules, { id, size: info.size }]
                        : modules.filter((item) => item.id !== id),
                    )
                  }
                />
              </li>
            );
          })}
        </ul>
      </div>
      <div className="settings-panel">
        <div className="settings-panel-heading">
          <div>
            <h3>{m.settings_pins_title()}</h3>
            <p>{m.settings_pins_description()}</p>
          </div>
        </div>
        {pinned.length ? (
          <ul className="settings-pins" aria-label={m.settings_pins_title()}>
            {pinned.map((pin, index) => (
              <li key={pin.path}>
                <Input
                  aria-label={m.settings_pin_name({ pin: pin.label })}
                  defaultValue={pin.label}
                  maxLength={120}
                  onBlur={(event) => {
                    const label = event.target.value.trim();
                    if (label && label !== pin.label)
                      savePins(
                        pinned.map((item) =>
                          item.path === pin.path ? { ...item, label } : item,
                        ),
                      );
                  }}
                />
                <code title={pin.path}>{pin.path}</code>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={m.settings_pin_earlier({ pin: pin.label })}
                  disabled={index === 0}
                  onClick={() => {
                    const next = [...pinned];
                    [next[index - 1], next[index]] = [pin, next[index - 1]!];
                    savePins(next);
                  }}
                >
                  <ArrowUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={m.settings_pin_remove({ pin: pin.label })}
                  onClick={() =>
                    savePins(pinned.filter((item) => item.path !== pin.path))
                  }
                >
                  <PinOff />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-note">{m.settings_pins_empty()}</p>
        )}
      </div>
      <ListSettingsReset organizationId={organizationId} />
    </section>
  );
}

/**
 * Clears the member's remembered state and display settings on every list in this workspace,
 * after confirmation. Saved views are not changed.
 */
function ListSettingsReset({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const reset = useMutation({
    mutationFn: () => resetAllCollectionStates(organizationId),
    onSuccess: () => {
      setConfirming(false);
      void queryClient.invalidateQueries({
        queryKey: ['private', 'organization', organizationId, 'collections'],
      });
    },
  });

  return (
    <div className="settings-panel">
      <div className="settings-panel-heading">
        <div>
          <h3>{m.settings_lists_title()}</h3>
          <p>{m.settings_lists_description()}</p>
        </div>
        {confirming ? (
          <span className="settings-confirm">
            <Button
              variant="destructive"
              disabled={reset.isPending}
              onClick={() => reset.mutate()}
            >
              {m.settings_lists_reset_confirm()}
            </Button>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {m.common_cancel()}
            </Button>
          </span>
        ) : (
          <Button variant="ghost" onClick={() => setConfirming(true)}>
            <RotateCcw aria-hidden="true" />
            {m.settings_lists_reset()}
          </Button>
        )}
      </div>
      {reset.isSuccess ? (
        <Alert role="status">
          {m.settings_lists_reset_done({ count: reset.data.removed })}
        </Alert>
      ) : reset.isError ? (
        <Alert tone="danger" role="alert">
          {m.settings_lists_reset_failed()}
        </Alert>
      ) : null}
    </div>
  );
}
