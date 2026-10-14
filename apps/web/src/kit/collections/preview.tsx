import './preview.css';

import type { ReactNode } from 'react';

/** One labelled fact of a preview pane, with an optional filter menu after its value. */
export function PreviewFact({
  label,
  children,
  menu,
}: {
  label: string;
  children: ReactNode;
  menu?: ReactNode;
}) {
  return (
    <div className="collection-preview-fact">
      <dt>{label}</dt>
      <dd>
        <span>{children}</span>
        {menu}
      </dd>
    </div>
  );
}
