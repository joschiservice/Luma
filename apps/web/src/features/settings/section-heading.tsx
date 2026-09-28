import { Badge } from '@luma/ui/components/primitives/badge';

/** Provides consistent headings for Settings sections. */
export function SectionHeading({
  title,
  description,
  badge,
}: {
  title: string;
  description: string;
  badge?: string;
}) {
  return (
    <header className="settings-section-heading">
      <div>
        <h2>
          {title} {badge ? <Badge>{badge}</Badge> : null}
        </h2>
        <p>{description}</p>
      </div>
    </header>
  );
}
