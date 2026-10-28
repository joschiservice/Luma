import { type PointerEvent, type ReactNode } from 'react';

/**
 * Renders a sidebar link's label on one line. When the label is cut off, which longer
 * translations often are, pointing at it shows the full text as a native tooltip.
 */
export function SidebarLinkLabel({ children }: { children: ReactNode }) {
  return (
    <span className="sidebar-link-label" onPointerEnter={titleWhenTruncated}>
      {children}
    </span>
  );
}

// Measured on hover rather than observed, so the sidebar adds no layout work while idle.
function titleWhenTruncated(event: PointerEvent<HTMLSpanElement>) {
  const label = event.currentTarget;
  if (label.scrollWidth > label.clientWidth)
    label.title = label.textContent ?? '';
  else label.removeAttribute('title');
}
