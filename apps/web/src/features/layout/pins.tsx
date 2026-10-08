import type { PinnedPage } from '@luma/api-contract';
import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import { DomainIcon } from '@luma/ui/components/primitives/domain-icon';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { Pin, PinOff, X } from 'lucide-react';

import { destinationFor } from '../identity/workspace-destinations';
import { useWorkspaceLayout } from './data';

const maxPins = 12;

/** Returns the current location relative to the workspace root, such as `exceptions?view=active`. */
function currentPath(organizationId: string, href: string) {
  const prefix = `/app/${organizationId}/`;

  return href.startsWith(prefix) ? href.slice(prefix.length) : null;
}

/** Names the current page from its main heading, falling back to the breadcrumb. */
function currentLabel() {
  const heading = document
    .querySelector('.desk-content h1')
    ?.textContent?.trim();
  const breadcrumb = document
    .querySelector('.header-context')
    ?.textContent?.trim();

  return (heading || breadcrumb || m.layout_pin_fallback_label()).slice(0, 120);
}

/**
 * Pins or unpins the current page, including its filters, in the reader's sidebar.
 * Pins are personal to the reader and this workspace.
 */
export function PinCurrentPage({ organizationId }: { organizationId: string }) {
  const href = useLocation({ select: (location) => location.href });
  const { layout, save } = useWorkspaceLayout(organizationId);
  const path = currentPath(organizationId, href);
  if (!layout || !path || path.startsWith('home')) return null;
  const pinned = layout.pinned.some((pin) => pin.path === path);
  const full = !pinned && layout.pinned.length >= maxPins;

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-pressed={pinned}
      aria-label={
        pinned ? m.layout_pin_unpin_current() : m.layout_pin_current()
      }
      title={
        full
          ? m.layout_pin_limit({ count: maxPins })
          : pinned
            ? m.layout_pin_unpin_current()
            : m.layout_pin_current()
      }
      disabled={full}
      onClick={() =>
        save({
          pinned: pinned
            ? layout.pinned.filter((pin) => pin.path !== path)
            : [...layout.pinned, { path, label: currentLabel() }],
        })
      }
    >
      {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
    </Button>
  );
}

/** Lists the reader's pinned pages in the sidebar, with a control to unpin each one. */
export function PinnedNavigation({
  organizationId,
  close,
}: {
  organizationId: string;
  close?: (() => void) | undefined;
}) {
  const href = useLocation({ select: (location) => location.href });
  const navigate = useNavigate();
  const { layout, save } = useWorkspaceLayout(organizationId);
  if (!layout?.pinned.length) return null;
  const current = currentPath(organizationId, href);
  const unpin = (pin: PinnedPage) =>
    save({ pinned: layout.pinned.filter((item) => item.path !== pin.path) });

  return (
    <section className="sidebar-section" aria-labelledby="nav-pinned">
      <h2 className="sidebar-section-label" id="nav-pinned">
        {m.layout_pinned_heading()}
      </h2>
      <ul className="sidebar-list">
        {layout.pinned.map((pin) => {
          const destination = destinationFor(`/app/x/${pin.path}`);
          const target = `/app/${organizationId}/${pin.path}`;

          return (
            <li key={pin.path} className="sidebar-pin">
              <a
                className="sidebar-link"
                data-label={pin.label}
                href={target}
                aria-current={current === pin.path ? 'page' : undefined}
                onClick={(event) => {
                  if (
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.button !== 0
                  )
                    return;
                  event.preventDefault();
                  close?.();
                  void navigate({ href: target });
                }}
              >
                {destination.domain ? (
                  <DomainIcon
                    domain={destination.domain}
                    size="xs"
                    className="sidebar-link-icon"
                  />
                ) : (
                  <destination.Icon
                    className="sidebar-link-icon"
                    size={16}
                    aria-hidden="true"
                  />
                )}
                <span className="sidebar-link-label">{pin.label}</span>
              </a>
              <button
                type="button"
                className="sidebar-unpin"
                aria-label={m.layout_pin_unpin({ page: pin.label })}
                onClick={() => unpin(pin)}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
