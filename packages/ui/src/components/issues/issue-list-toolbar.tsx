import { caseClasses, type CaseQuery, caseStates } from '@luma/api-contract';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleDot,
  Flag,
  Plus,
  RefreshCw,
  Shapes,
  X,
} from 'lucide-react';
import {
  type ReactElement,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { useSmallScreen } from '../../lib/use-small-screen';
import { Button } from '../primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu';
import { ResponsivePopover } from '../primitives/responsive-popover';
import { caseLabel } from './case-investigation';

type Filters = Pick<CaseQuery, 'state' | 'class' | 'severity'>;

type FilterField = keyof Filters;

const fields = ['severity', 'class', 'state'] as const;
const labels = { state: 'State', class: 'Issue type', severity: 'Severity' };
const categoryIcons = { state: CircleDot, class: Shapes, severity: Flag };
const values = {
  state: caseStates,
  class: caseClasses,
  severity: ['high', 'medium'],
};

/** Groups issue views and editable filter chips without owning routing or data fetching. */
export function IssueListToolbar({
  views,
  filters,
  onFiltersChange,
  onRefresh,
  refreshing = false,
}: {
  views: ReactNode;
  filters: Filters;
  onFiltersChange: (patch: Partial<Filters>) => void;
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  const [picker, setPicker] = useState<FilterField | 'add' | null>(null);
  const [adding, setAdding] = useState<FilterField | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const pickerOptions = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (picker === 'add')
      pickerOptions.current?.querySelector('button')?.focus();
  }, [adding, picker]);
  const available = fields.filter((field) => !filters[field]);
  const active = fields.filter((field) => filters[field]);
  const remove = (patch: Partial<Filters>) => {
    onFiltersChange(patch);
    requestAnimationFrame(() => addButton.current?.focus());
  };
  const options = (field: FilterField) => (
    <div
      className="issue-filter-options"
      ref={pickerOptions}
      aria-label={`${labels[field]} values`}
    >
      {values[field].map((value) => (
        <Button
          key={value}
          variant="ghost"
          aria-pressed={filters[field] === value}
          onClick={() => {
            onFiltersChange({ [field]: value });
            setPicker(null);
          }}
        >
          {caseLabel(value)}
          {filters[field] === value && <Check aria-hidden="true" />}
        </Button>
      ))}
    </div>
  );

  return (
    <div className="inbox-toolbar">
      <div className="inbox-views">
        {views}
        <Button
          variant="ghost"
          aria-label="Refresh issues"
          title="Refresh issues"
          onClick={onRefresh}
          disabled={refreshing}
        >
          <RefreshCw size={14} aria-hidden="true" />{' '}
          <span className="issue-refresh-label">Refresh</span>
        </Button>
      </div>
      <div className="issue-filter-chips" aria-label="Issue filters">
        {active.map((field) => (
          <div className="issue-filter-chip" key={field}>
            <FilterPicker
              fields={[field]}
              filters={filters}
              onFiltersChange={onFiltersChange}
              title={labels[field]}
              open={picker === field}
              onOpenChange={(open) => setPicker(open ? field : null)}
              trigger={
                <Button
                  variant="ghost"
                  aria-label={`Edit ${labels[field]} filter: ${caseLabel(filters[field]!)}`}
                >
                  <span className="issue-filter-label">{labels[field]}:</span>{' '}
                  {caseLabel(filters[field]!)}
                </Button>
              }
            >
              {options(field)}
            </FilterPicker>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${labels[field]} filter: ${caseLabel(filters[field]!)}`}
              onClick={() => remove({ [field]: undefined })}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        ))}
        <FilterPicker
          fields={available}
          filters={filters}
          onFiltersChange={onFiltersChange}
          nested
          title={adding ? labels[adding] : 'Add filter'}
          open={picker === 'add'}
          onOpenChange={(open) => {
            setPicker(open ? 'add' : null);
            if (open) setAdding(null);
          }}
          trigger={
            <Button
              ref={addButton}
              variant="ghost"
              className="issue-filter-add"
              disabled={!available.length}
            >
              <Plus aria-hidden="true" /> Add filter
            </Button>
          }
        >
          {adding ? (
            <>
              <Button variant="ghost" onClick={() => setAdding(null)}>
                <ArrowLeft aria-hidden="true" /> Filter categories
              </Button>
              {options(adding)}
            </>
          ) : (
            <div className="issue-filter-options" ref={pickerOptions}>
              {available.map((field) => (
                <Button
                  key={field}
                  variant="ghost"
                  onClick={() => setAdding(field)}
                >
                  <FilterCategoryLabel field={field} />{' '}
                  <ChevronRight aria-hidden="true" />
                </Button>
              ))}
            </div>
          )}
        </FilterPicker>
        {active.length > 0 && (
          <Button
            variant="ghost"
            onClick={() =>
              remove({
                state: undefined,
                class: undefined,
                severity: undefined,
              })
            }
          >
            Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}

function FilterPicker({
  fields: choices,
  filters,
  onFiltersChange,
  nested = false,
  ...props
}: {
  fields: readonly FilterField[];
  filters: Filters;
  onFiltersChange: (patch: Partial<Filters>) => void;
  nested?: boolean;
  trigger: ReactElement;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const mobile = useSmallScreen();
  if (mobile) return <ResponsivePopover {...props} />;

  const items = (field: FilterField) => (
    <DropdownMenuRadioGroup
      value={filters[field] ?? ''}
      onValueChange={(value) => onFiltersChange({ [field]: value })}
    >
      {values[field].map((value) => (
        <DropdownMenuRadioItem key={value} value={value} closeOnClick>
          {caseLabel(value)}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );

  return (
    <DropdownMenu open={props.open} onOpenChange={props.onOpenChange}>
      <DropdownMenuTrigger render={props.trigger} />
      <DropdownMenuContent aria-label={props.title} className="min-w-44">
        <DropdownMenuGroup>
          {choices.map((field) =>
            nested ? (
              <DropdownMenuSub key={field}>
                <DropdownMenuSubTrigger>
                  <FilterCategoryLabel field={field} />
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  aria-label={labels[field]}
                  className="min-w-44"
                >
                  {items(field)}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : (
              <DropdownMenuGroup key={field}>{items(field)}</DropdownMenuGroup>
            ),
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FilterCategoryLabel({ field }: { field: FilterField }) {
  const Icon = categoryIcons[field];

  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon aria-hidden="true" />
      {labels[field]}
    </span>
  );
}
