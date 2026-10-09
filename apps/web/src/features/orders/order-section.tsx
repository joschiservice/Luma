import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Groups one part of the order record in a card with an icon and title. `description` explains
 * something the reader needs to interpret the content correctly; `action` sits beside the title.
 */
export function OrderSection({
  title,
  icon: Icon,
  description,
  action,
  children,
}: {
  title: string;
  icon: LucideIcon;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card as="section" aria-label={title}>
      <CardHeader>
        <div>
          <CardTitle>
            <Icon aria-hidden="true" />
            {title}
          </CardTitle>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
        </div>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
