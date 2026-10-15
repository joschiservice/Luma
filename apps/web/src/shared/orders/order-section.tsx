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
 * something the reader needs to interpret the content correctly; `status` follows the title,
 * such as a badge saying the section has nothing to show; `action` sits beside the title.
 * Without `children`, the section is its header alone, so an empty section stays in place
 * without taking the space of its content.
 */
export function OrderSection({
  title,
  icon: Icon,
  description,
  status,
  action,
  children,
}: {
  title: string;
  icon: LucideIcon;
  description?: string | undefined;
  status?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card as="section" aria-label={title}>
      <CardHeader>
        <div>
          <CardTitle>
            <Icon aria-hidden="true" />
            {title}
            {status ? (
              <span className="order-section-status">{status}</span>
            ) : null}
          </CardTitle>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
        </div>
        {action}
      </CardHeader>
      {children ? <CardContent>{children}</CardContent> : null}
    </Card>
  );
}
