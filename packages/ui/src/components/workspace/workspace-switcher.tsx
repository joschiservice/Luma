import { Menu } from '@base-ui/react/menu';
import { m } from '@luma/i18n/messages';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
import type { ReactElement } from 'react';

export type WorkspaceChoice = { id: string; name: string; link: ReactElement };

/** Returns up to two initials for a workspace or person, for avatar tiles. */
export function initialsOf(name: string, fallback = 'W') {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0])
      .join('')
      .toUpperCase() || fallback
  );
}

/**
 * Shows the current workspace and lets people switch to another one or create a new
 * workspace. Each choice supplies its own link so the host keeps routing control.
 */
export function WorkspaceSwitcher({
  workspace,
  workspaceId,
  workspaces,
  createLink,
}: {
  workspace: string;
  workspaceId: string;
  workspaces: WorkspaceChoice[];
  createLink: ReactElement;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        className="workspace-switcher"
        aria-label={m.ui_workspace_switcher_open({ workspace })}
      >
        <span className="workspace-avatar" aria-hidden="true">
          {initialsOf(workspace).slice(0, 1)}
        </span>
        <span className="workspace-switcher-name" title={workspace}>
          {workspace}
        </span>
        <ChevronsUpDown
          className="workspace-switcher-chevron"
          size={14}
          aria-hidden="true"
        />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="start" className="z-50">
          <Menu.Popup className="lu-popover workspace-menu">
            <Menu.Group>
              <Menu.GroupLabel className="workspace-menu-label">
                {m.ui_workspace_switcher_heading()}
              </Menu.GroupLabel>
              <div className="workspace-menu-list">
                {workspaces.map((choice) => (
                  <Menu.Item
                    key={choice.id}
                    render={choice.link}
                    className="lu-menu-item"
                    aria-current={
                      choice.id === workspaceId ? 'true' : undefined
                    }
                  >
                    <span className="workspace-avatar" aria-hidden="true">
                      {initialsOf(choice.name).slice(0, 1)}
                    </span>
                    <span className="workspace-menu-name">{choice.name}</span>
                    {choice.id === workspaceId ? (
                      <Check
                        className="workspace-menu-check"
                        size={14}
                        aria-hidden="true"
                      />
                    ) : null}
                  </Menu.Item>
                ))}
              </div>
            </Menu.Group>
            <Menu.Separator className="workspace-menu-separator" />
            <Menu.Item render={createLink} className="lu-menu-item">
              <Plus size={15} aria-hidden="true" />
              {m.ui_workspace_create()}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
