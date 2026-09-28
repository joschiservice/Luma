import type { HomeModule, HomeModuleId, PinnedPage } from '@luma/api-contract';
import { homeModuleIds } from '@luma/api-contract';
import { Alert } from '@luma/ui/components/primitives/alert';
import { Button } from '@luma/ui/components/primitives/button';
import { Input } from '@luma/ui/components/primitives/input';
import { Select } from '@luma/ui/components/primitives/select';
import { Switch } from '@luma/ui/components/primitives/switch';
import {
  ArrowDown,
  ArrowUp,
  Monitor,
  Moon,
  PinOff,
  RotateCcw,
  Sun,
} from 'lucide-react';
import { useId } from 'react';

import { setSidebarCollapsed, useSidebarCollapsed } from '../../lib/sidebar';
import {
  setThemePreference,
  type ThemePreference,
  useThemePreference,
} from '../../lib/theme';
import { defaultHome, homeModules, moveModule } from '../home/preferences';
import { useWorkspaceLayout } from '../layout/data';
import { SectionHeading } from './section-heading';

const themes: {
  value: ThemePreference;
  label: string;
  description: string;
  Icon: typeof Sun;
}[] = [
  {
    value: 'system',
    label: 'System',
    description: 'Follow your device setting',
    Icon: Monitor,
  },
  {
    value: 'light',
    label: 'Light',
    description: 'Canvas and graphite',
    Icon: Sun,
  },
  {
    value: 'dark',
    label: 'Dark',
    description: 'Deep surface and azure',
    Icon: Moon,
  },
];

/** Lets the reader choose the theme and default sidebar width on this device. */
export function AppearanceSettings() {
  const theme = useThemePreference();
  const collapsed = useSidebarCollapsed();
  const titleId = useId();
  const descriptionId = useId();

  return (
    <section>
      <SectionHeading
        title="Appearance"
        description="How Luma looks on this device. Light and dark are equally supported."
        badge="This device"
      />
      <div className="settings-panel">
        <fieldset className="settings-themes">
          <legend>Theme</legend>
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
                  <strong>{label}</strong>
                </span>
                <span className="settings-theme-description">
                  {description}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="settings-preference">
          <span>
            <strong id={titleId}>Collapse the sidebar</strong>
            <span id={descriptionId}>
              Show icons only and keep more room for your work. Press [ to
              switch at any time.
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
  const modules = workspace.layout?.home ?? defaultHome;
  const pinned = workspace.layout?.pinned ?? [];
  const saveHome = (home: HomeModule[]) => workspace.save({ home });
  const savePins = (next: PinnedPage[]) => workspace.save({ pinned: next });
  const ordered: HomeModuleId[] = [
    ...modules.map((module) => module.id),
    ...homeModuleIds.filter((id) => !modules.some((m) => m.id === id)),
  ];

  return (
    <section>
      <SectionHeading
        title="Home & sidebar"
        description="Choose what your Home shows and which pages stay pinned in your sidebar. Only you see these choices."
        badge="Personal"
      />
      {workspace.conflict ? (
        <Alert tone="warning" role="status">
          Your layout changed in another session. We loaded the latest version.
        </Alert>
      ) : workspace.saveFailed ? (
        <Alert tone="danger" role="alert">
          Your last change couldn’t be saved. Check your connection and try
          again.
        </Alert>
      ) : null}
      <div className="settings-panel">
        <div className="settings-panel-heading">
          <div>
            <h3>Home modules</h3>
            <p>Shown modules appear on Home in this order.</p>
          </div>
          <Button
            variant="ghost"
            disabled={!workspace.layout || workspace.layout.home === null}
            onClick={() => workspace.save({ home: null })}
          >
            <RotateCcw aria-hidden="true" />
            Reset to default
          </Button>
        </div>
        <ul className="settings-modules" aria-label="Home modules">
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
                      aria-label={`${info.title} width`}
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
                        { value: 'half', label: 'Half width' },
                        { value: 'full', label: 'Full width' },
                      ]}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Move ${info.title} earlier`}
                      disabled={index === 0}
                      onClick={() => saveHome(moveModule(modules, id, -1))}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Move ${info.title} later`}
                      disabled={index === modules.length - 1}
                      onClick={() => saveHome(moveModule(modules, id, 1))}
                    >
                      <ArrowDown />
                    </Button>
                  </>
                ) : null}
                <Switch
                  aria-label={`Show ${info.title} on Home`}
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
            <h3>Pinned pages</h3>
            <p>
              Pin any page, including its filters, with the pin button in the
              top bar. Rename pins here.
            </p>
          </div>
        </div>
        {pinned.length ? (
          <ul className="settings-pins" aria-label="Pinned pages">
            {pinned.map((pin, index) => (
              <li key={pin.path}>
                <Input
                  aria-label={`Name for ${pin.label}`}
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
                  aria-label={`Move ${pin.label} up`}
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
                  aria-label={`Unpin ${pin.label}`}
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
          <p className="settings-note">
            Nothing pinned yet. Open a page you use often and select the pin in
            the top bar.
          </p>
        )}
      </div>
    </section>
  );
}
