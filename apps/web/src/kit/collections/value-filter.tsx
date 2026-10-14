import { m } from '@luma/i18n/messages';
import { Button } from '@luma/ui/components/primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@luma/ui/components/primitives/dropdown-menu';
import type { CellFilterValue } from '@luma/ui/lib/collection-conditions';
import { ListFilter } from 'lucide-react';

/** Narrows a list to a value shown in its preview, or excludes the value. */
export type CollectionValueFilter = (
  field: string,
  value: CellFilterValue,
  exclude: boolean,
) => void;

/**
 * An icon button beside a value in a preview pane that offers "Show only this value" and "Hide
 * this value". `label` names the button for assistive technology, such as "Filter by Retail".
 */
export function ValueFilterMenu({
  field,
  value,
  label,
  filter,
  className,
}: {
  field: string;
  value: CellFilterValue;
  label: string;
  filter: CollectionValueFilter;
  className?: string | undefined;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className={className}
            aria-label={label}
            title={label}
          >
            <ListFilter aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-auto min-w-48">
        <DropdownMenuItem onClick={() => filter(field, value, false)}>
          {m.collections_filter_to_value()}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => filter(field, value, true)}>
          {m.collections_exclude_value()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
