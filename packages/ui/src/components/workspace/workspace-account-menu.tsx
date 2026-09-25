import { Menu } from '@base-ui/react/menu';
import {
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  LogOut,
  Plus,
} from 'lucide-react';
import type { ReactElement } from 'react';

export type WorkspaceChoice = { id: string; name: string; link: ReactElement };

/** Groups account and workspace navigation in an accessible dropdown. */
export function WorkspaceAccountMenu({
  name,
  workspace,
  workspaceId,
  workspaces,
  createLink,
}: {
  name: string;
  workspace: string;
  workspaceId: string;
  workspaces: WorkspaceChoice[];
  createLink: ReactElement;
}) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0])
      .join('')
      .toUpperCase() || 'U';

  return (
    <Menu.Root>
      <Menu.Trigger
        className="workspace-account-trigger"
        aria-label={`${name}, ${workspace}. Open account menu`}
      >
        <span className="account-avatar" aria-hidden="true">
          {initials}
        </span>
        <span className="account-identity">
          <strong title={name}>{name}</strong>
          <span title={workspace}>{workspace}</span>
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          sideOffset={8}
          align="end"
          className="account-positioner"
        >
          <Menu.Popup className="workspace-account-popup">
            <Menu.Group>
              <Menu.GroupLabel className="account-menu-name">
                {name}
              </Menu.GroupLabel>
              <Menu.SubmenuRoot>
                <Menu.SubmenuTrigger
                  className="account-menu-item account-workspace-row"
                  openOnHover={false}
                >
                  <Building2 size={16} aria-hidden="true" />
                  <span title={workspace}>{workspace}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </Menu.SubmenuTrigger>
                <Menu.Portal>
                  <Menu.Positioner
                    side="left"
                    align="start"
                    sideOffset={8}
                    className="account-positioner"
                  >
                    <Menu.Popup className="workspace-account-popup">
                      <Menu.Group>
                        <Menu.GroupLabel className="account-menu-name">
                          Workspaces
                        </Menu.GroupLabel>
                        <div className="account-workspace-list">
                          {workspaces.map((org) => (
                            <Menu.Item
                              key={org.id}
                              render={org.link}
                              className="account-menu-item"
                              aria-current={
                                org.id === workspaceId ? 'true' : undefined
                              }
                            >
                              <Building2 size={16} aria-hidden="true" />
                              <span className="account-workspace-label">
                                {org.name}
                              </span>
                              {org.id === workspaceId ? (
                                <Check size={16} aria-hidden="true" />
                              ) : null}
                            </Menu.Item>
                          ))}
                        </div>
                      </Menu.Group>
                      <Menu.Separator className="account-menu-separator" />
                      <Menu.Item
                        render={createLink}
                        className="account-menu-item"
                      >
                        <Plus size={16} aria-hidden="true" />
                        Create workspace
                      </Menu.Item>
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.SubmenuRoot>
            </Menu.Group>
            <Menu.Separator className="account-menu-separator" />
            <Menu.Item
              render={<a href="/sign-out" />}
              className="account-menu-item"
            >
              <LogOut size={16} aria-hidden="true" />
              Sign out
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
