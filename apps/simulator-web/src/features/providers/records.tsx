import type { ProviderRecord, RunDetail } from '@luma/simulator-contract';
import { Button } from '@luma/ui/components/primitives/button';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@luma/ui/components/primitives/card';
import {
  DataTable,
  type DataTableColumn,
} from '@luma/ui/components/primitives/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@luma/ui/components/primitives/dialog';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Pagination } from '@luma/ui/components/primitives/pagination';
import { useId, useState } from 'react';

import { SelectField } from '../../components/fields';
import { JsonView } from '../../components/json-view';
import { LoadError, Loading } from '../../components/query-state';
import { formatCount, formatDateTime } from '../../lib/format';
import { useRecordKinds, useRecords } from '../../queries';

const pageSize = 25;

/**
 * Browses one provider instance's stored records by kind, a page at a time. Opening a record
 * shows its full JSON in a side sheet.
 */
export function RecordBrowser({ run }: { run: RunDetail }) {
  const [instance, setInstance] = useState(run.instances[0]?.name ?? '');
  const kinds = useRecordKinds(run.id, instance || null);
  const [kind, setKind] = useState<string | null>(null);
  const kindList = kinds.data ?? [];
  const currentKind =
    kind !== null && kindList.some((entry) => entry.kind === kind)
      ? kind
      : (kindList[0]?.kind ?? null);

  return (
    <Card as="section" aria-labelledby="records-title">
      <CardHeader>
        <div>
          <CardTitle id="records-title">Provider records</CardTitle>
          <CardDescription>
            What each simulated system stores, as its API would return it.
          </CardDescription>
        </div>
      </CardHeader>
      <div className="sim-field-grid">
        <SelectField
          label="Instance"
          value={instance}
          options={run.instances.map((i) => ({
            value: i.name,
            label: i.label,
          }))}
          onChange={(value) => {
            setInstance(value);
            setKind(null);
          }}
        />
        {kindList.length > 0 && currentKind ? (
          <SelectField
            label="Record kind"
            value={currentKind}
            options={kindList.map((entry) => ({
              value: entry.kind,
              label: `${entry.kind} (${formatCount(entry.count)})`,
            }))}
            onChange={setKind}
          />
        ) : null}
      </div>
      {kinds.isPending ? (
        <Loading label="Loading record kinds" />
      ) : kinds.isError ? (
        <LoadError
          title="Record kinds unavailable"
          error={kinds.error}
          onRetry={() => void kinds.refetch()}
        />
      ) : currentKind === null ? (
        <p className="sim-muted">This instance stores no records yet.</p>
      ) : (
        <RecordPages
          key={`${instance}:${currentKind}`}
          runId={run.id}
          instance={instance}
          kind={currentKind}
        />
      )}
    </Card>
  );
}

function RecordPages({
  runId,
  instance,
  kind,
}: {
  runId: string;
  instance: string;
  kind: string;
}) {
  const id = useId();
  const [parent, setParent] = useState('');
  // Cursors of the pages before the current one; the last entry opens the current page.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [open, setOpen] = useState<ProviderRecord | null>(null);
  const after = cursors.at(-1);
  const records = useRecords(runId, instance, {
    kind,
    limit: pageSize,
    ...(after ? { after } : {}),
    ...(parent.trim() ? { parent: parent.trim() } : {}),
  });
  const columns: DataTableColumn<ProviderRecord>[] = [
    {
      key: 'id',
      header: 'ID',
      cell: (record) => (
        <Button
          variant="ghost"
          size="sm"
          className="sim-mono"
          aria-label={`Show record ${record.id}`}
          onClick={() => setOpen(record)}
        >
          {record.id}
        </Button>
      ),
    },
    {
      key: 'parent',
      header: 'Parent',
      hideOnNarrow: true,
      cell: (record) =>
        record.parent ? (
          <code>{record.parent}</code>
        ) : (
          <span className="sim-muted">—</span>
        ),
    },
    {
      key: 'key',
      header: 'Key',
      cell: (record) =>
        record.key ? (
          <code>{record.key}</code>
        ) : (
          <span className="sim-muted">—</span>
        ),
    },
    {
      key: 'updated',
      header: 'Updated',
      hideOnNarrow: true,
      cell: (record) => (
        <span className="lu-numeric">{formatDateTime(record.updatedAt)}</span>
      ),
    },
  ];

  return (
    <>
      <Field className="sim-parent-filter">
        <FieldLabel htmlFor={`${id}-parent`}>Parent ID (optional)</FieldLabel>
        <Input
          id={`${id}-parent`}
          value={parent}
          placeholder="Only children of this record"
          onChange={(event) => {
            setParent(event.currentTarget.value);
            setCursors([undefined]);
          }}
        />
      </Field>
      {records.isPending ? (
        <Loading label="Loading records" />
      ) : records.isError ? (
        <LoadError
          title="Records unavailable"
          error={records.error}
          onRetry={() => void records.refetch()}
        />
      ) : (
        <>
          <DataTable
            caption={`${kind} records`}
            columns={columns}
            rows={records.data.items}
            rowKey={(record) => record.id}
            density="compact"
            variant="plain"
            empty={<p className="sim-muted">No records on this page.</p>}
          />
          <Pagination
            count={records.data.items.length}
            offset={(cursors.length - 1) * pageSize}
            pageSize={pageSize}
            hasNext={records.data.next !== null}
            disabled={records.isFetching && records.isPlaceholderData}
            emptyLabel="No records"
            label="Record pages"
            onPrevious={
              cursors.length > 1
                ? () => setCursors((list) => list.slice(0, -1))
                : undefined
            }
            onNext={() => {
              const next = records.data.next;
              if (next) setCursors((list) => [...list, next]);
            }}
          />
        </>
      )}
      <Dialog
        open={open !== null}
        onOpenChange={(value) => {
          if (!value) setOpen(null);
        }}
      >
        <DialogContent placement="sheet">
          <DialogHeader>
            <DialogTitle>
              {kind} <code>{open?.id}</code>
            </DialogTitle>
            <DialogDescription>
              {open
                ? `Created ${formatDateTime(open.createdAt)} · updated ${formatDateTime(open.updatedAt)}`
                : ''}
            </DialogDescription>
          </DialogHeader>
          {open ? <JsonView value={open.data} label="Record data" /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
