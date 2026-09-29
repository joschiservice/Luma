import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import type { ReactNode } from 'react';

/** Groups one part of the order record in a labeled card with an optional explanation. */
export function OrderSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card as="section" aria-label={title}>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
