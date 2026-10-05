import type { RunDetail } from '@luma/simulator-contract';
import type { JournalEntry } from '@luma/simulator-core';
import { Button } from '@luma/ui/components/primitives/button';
import { Card } from '@luma/ui/components/primitives/card';
import { Field, FieldLabel } from '@luma/ui/components/primitives/field';
import { Input } from '@luma/ui/components/primitives/input';
import { Switch } from '@luma/ui/components/primitives/switch';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';

import { errorMessage, type JournalQuery } from '../../api';
import { SelectField } from '../../components/fields';
import { JsonView } from '../../components/json-view';
import { LoadError, Loading } from '../../components/query-state';
import { formatTime, summarizeJson } from '../../lib/format';
import { useConnection, useJournalHead } from '../../queries';

/** Entries rendered at first; more are revealed in steps of this size. */
const step = 200;

/** Merges newest-first pages, dropping repeated entries by sequence. */
export function mergeJournal(...pages: (readonly JournalEntry[])[]) {
  const seen = new Set<number>();
  const merged: JournalEntry[] = [];
  for (const entry of pages.flat()) {
    if (seen.has(entry.sequence)) continue;
    seen.add(entry.sequence);
    merged.push(entry);
  }

  return merged.sort((a, b) => b.sequence - a.sequence);
}

/**
 * The run's activity journal, newest first. It follows new entries while live; reading older
 * pages pauses live updates so the list stays contiguous. Rendering is capped and grows on
 * request, so thousands of loaded entries stay responsive.
 */
export function JournalView({ run }: { run: RunDetail }) {
  const id = useId();
  const [kindText, setKindText] = useState('');
  const [kind, setKind] = useState('');
  const [instance, setInstance] = useState('all');
  useEffect(() => {
    const timer = window.setTimeout(() => setKind(kindText.trim()), 400);

    return () => window.clearTimeout(timer);
  }, [kindText]);
  const filters: JournalQuery = {
    limit: 100,
    ...(kind ? { kind } : {}),
    ...(instance === 'all' ? {} : { instance }),
  };

  return (
    <div className="sim-stack">
      <div className="sim-toolbar">
        <h2 className="sim-section-title">Journal</h2>
        <div className="sim-filters">
          <Field className="sim-kind-filter">
            <FieldLabel htmlFor={`${id}-kind`}>Kind</FieldLabel>
            <Input
              id={`${id}-kind`}
              value={kindText}
              list={`${id}-kinds`}
              placeholder="All kinds"
              spellCheck={false}
              onChange={(event) => setKindText(event.currentTarget.value)}
            />
          </Field>
          <SelectField
            label="Instance"
            className="sim-instance-filter"
            value={instance}
            options={[
              { value: 'all', label: 'All instances' },
              ...run.instances.map((i) => ({ value: i.name, label: i.label })),
            ]}
            onChange={setInstance}
          />
        </div>
      </div>
      <JournalList
        key={`${kind}:${instance}`}
        runId={run.id}
        filters={filters}
        kindsListId={`${id}-kinds`}
      />
    </div>
  );
}

function JournalList({
  runId,
  filters,
  kindsListId,
}: {
  runId: string;
  filters: JournalQuery;
  kindsListId: string;
}) {
  const { api } = useConnection();
  const [live, setLive] = useState(true);
  const [older, setOlder] = useState<{
    items: JournalEntry[];
    cursor: number | null;
  } | null>(null);
  const [visible, setVisible] = useState(step);
  const head = useJournalHead(runId, filters, live);
  const loadOlder = useMutation({
    mutationFn: (before: number) => api.journal(runId, { ...filters, before }),
    onSuccess: (page) =>
      setOlder((current) => ({
        items: [...(current?.items ?? []), ...page.items],
        cursor: page.nextCursor,
      })),
  });
  if (head.isPending) return <Loading label="Loading the journal" />;
  if (head.isError && !head.data)
    return (
      <LoadError
        title="Journal unavailable"
        error={head.error}
        onRetry={() => void head.refetch()}
      />
    );
  const entries = mergeJournal(head.data.items, older?.items ?? []);
  const cursor = older ? older.cursor : head.data.nextCursor;
  const shown = entries.slice(0, visible);
  const kinds = [...new Set(entries.map((entry) => entry.kind))].sort();

  function showOlder() {
    if (entries.length > visible) {
      setVisible((count) => count + step);

      return;
    }
    if (cursor === null) return;
    setLive(false);
    loadOlder.mutate(cursor, {
      onSuccess: () => setVisible((count) => count + step),
    });
  }

  return (
    <Card className="sim-journal">
      <datalist id={kindsListId}>
        {kinds.map((kind) => (
          <option key={kind} value={kind} />
        ))}
      </datalist>
      <div className="sim-toolbar">
        <label className="sim-switch">
          <Switch
            aria-labelledby={`${kindsListId}-follow`}
            checked={live}
            onCheckedChange={(checked) => {
              setLive(checked);
              if (checked) {
                setOlder(null);
                setVisible(step);
              }
            }}
          />
          <span id={`${kindsListId}-follow`}>Follow new entries</span>
        </label>
        <span className="sim-muted" role="status">
          {live
            ? 'Live: refreshes every 5 seconds'
            : 'Paused while reading older entries'}
          {head.isError ? ' · refresh failed' : ''}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="sim-muted">No journal entries match these filters.</p>
      ) : (
        <ol
          className="sim-journal-list"
          aria-label="Journal entries, newest first"
        >
          {shown.map((entry) => (
            <JournalRow key={entry.sequence} entry={entry} />
          ))}
        </ol>
      )}
      <div className="sim-actions">
        {entries.length > visible || cursor !== null ? (
          <Button
            variant="outline"
            disabled={loadOlder.isPending}
            onClick={showOlder}
          >
            {loadOlder.isPending ? 'Loading…' : 'Load older'}
          </Button>
        ) : (
          <span className="sim-muted">Beginning of the journal.</span>
        )}
        <span className="sim-muted lu-numeric">
          Showing {shown.length.toLocaleString('en')} of{' '}
          {entries.length.toLocaleString('en')} loaded
        </span>
      </div>
      {loadOlder.isError ? (
        <p className="sim-error-text" role="alert">
          Older entries did not load: {errorMessage(loadOlder.error)}
        </p>
      ) : null}
    </Card>
  );
}

function JournalRow({ entry }: { entry: JournalEntry }) {
  const [open, setOpen] = useState(false);

  return (
    <li className="sim-journal-entry">
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span className="sim-muted lu-numeric">#{entry.sequence}</span>
          <time
            className="lu-numeric"
            dateTime={new Date(entry.time).toISOString()}
          >
            {formatTime(entry.time)}
          </time>
          <strong>{entry.kind}</strong>
          {entry.instance ? <span>{entry.instance}</span> : null}
          {entry.resource ? <code>{entry.resource}</code> : null}
          <code className="sim-journal-detail">
            {summarizeJson(entry.detail)}
          </code>
        </summary>
        {open ? (
          <JsonView
            value={entry.detail}
            label={`Entry ${entry.sequence} detail`}
          />
        ) : null}
      </details>
    </li>
  );
}
