import type { IncidentView, Scorecard } from '@luma/simulator-contract';
import { incidentKinds, type RecordPage } from '@luma/simulator-core';
import type { Pool } from 'pg';

import type { Incident } from '../engine/world.js';
import { createPgStore } from '../pg-store.js';
import { currentTime, type RunRecord } from './runs.js';

/** A Luma case as the scorecard needs it; supplied by the local pilot, never read by providers. */
export interface LumaCase {
  id: string;
  exceptionClass: string;
  detectedAt: string;
  resolvedAt: string | null;
  /** Closed by a verification that was not passed, complete and authoritative. */
  closedWithoutVerification: boolean;
  verified: boolean;
  /** Simulator instances of the connections in the case's evidence. */
  instances: string[];
  /** Provider record IDs in the case's subject and evidence. */
  identifiers: string[];
  url: string | null;
  /** The latest workflow run this case started, with its process state. */
  workflow?: { name: string; state: string; url: string } | null;
}

/** Reads Luma's cases for a run; rejects when Luma is unreachable. */
export type LumaCases = (runId: string) => Promise<LumaCase[]>;

const minute = 60_000;

/** How long Luma's rules may take to open a case before an incident counts as missed. */
const detectionWindow: Record<string, number> = {
  inventory_mismatch: 15 * minute,
  // The quantity rule waits for the propagation window, then for fresh reads of every source.
  order_quantity_mismatch: 45 * minute,
  stuck_fulfillment: 3 * 60 * minute,
  sync_failure: 30 * minute,
  workflow_failure: 30 * minute,
};

/** Reads every ground-truth incident of a run, newest first. */
export async function readIncidents(pool: Pool, run: RunRecord) {
  const client = await pool.connect();
  try {
    const store = createPgStore(client, 'sim_world_records', run.id, 'world');
    const incidents: Incident[] = [];
    let after: string | null = null;
    do {
      const page: RecordPage<Incident> = await store.page<Incident>({
        kind: 'incident',
        order: 'updated',
        reverse: true,
        limit: 500,
        after,
      });
      incidents.push(...page.items.map((item) => item.data));
      after = page.next;
    } while (after && incidents.length < 5_000);

    return incidents;
  } finally {
    client.release();
  }
}

function matches(incident: Incident, item: LumaCase) {
  const expected = incidentKinds[incident.kind].exceptionClass;
  if (item.exceptionClass !== expected) return false;
  if (Date.parse(item.detectedAt) < incident.startedAt - minute) return false;
  if (expected === 'sync_failure')
    return !!incident.instance && item.instances.includes(incident.instance);
  const ids = new Set(item.identifiers);
  // Every case at a location names it, so match on the record itself when one is known.
  const specific = incident.resources.filter(
    (resource) => resource.kind !== 'Location',
  );

  return (specific.length ? specific : incident.resources).some((resource) =>
    ids.has(resource.id),
  );
}

/** Combines an incident with the Luma case that detected it, if any. */
export function viewIncident(
  incident: Incident,
  cases: LumaCase[] | null,
  now: number,
): IncidentView {
  const kind = incidentKinds[incident.kind];
  let detection: IncidentView['detection'] = null;
  if (incident.status !== 'planned') {
    const found = cases?.find((item) => matches(incident, item));
    const state: NonNullable<IncidentView['detection']>['state'] =
      !kind.exceptionClass
        ? 'not-covered'
        : found
          ? 'detected'
          : now - incident.startedAt >
              (detectionWindow[kind.exceptionClass] ?? 30 * minute)
            ? 'missed'
            : 'pending';
    detection = cases
      ? {
          state,
          caseId: found?.id ?? null,
          caseUrl: found?.url ?? null,
          detectedAt: found ? Date.parse(found.detectedAt) : null,
          resolved: !!found?.resolvedAt,
          verified: !!found?.verified,
          workflow: found?.workflow ?? null,
        }
      : null;
  }

  return {
    id: incident.id,
    kind: incident.kind,
    label: kind.label,
    status: incident.status,
    origin: incident.origin,
    startedAt: incident.startedAt,
    endedAt: incident.endedAt,
    instance: incident.instance,
    summary: incident.summary,
    resources: incident.resources,
    expected: { exceptionClass: kind.exceptionClass, surface: kind.surface },
    detection,
  };
}

/**
 * Scores Luma against the run's ground truth: detected, pending, missed and uncovered
 * incidents, time to detect, cases without ground truth, closures without verification, and
 * repeated provider writes.
 */
export async function scorecard(
  pool: Pool,
  run: RunRecord,
  luma: LumaCases | undefined,
): Promise<Scorecard> {
  const now = currentTime(run);
  let cases: LumaCase[] | null = null;
  let error: string | null = luma ? null : 'This run is not connected to Luma.';
  if (luma)
    try {
      cases = await luma(run.id);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Luma is unavailable';
    }
  const incidents = (await readIncidents(pool, run)).filter(
    (item) => item.status !== 'planned',
  );
  const views = incidents.map((incident) => viewIncident(incident, cases, now));
  const count = (state: string, list = views) =>
    list.filter((view) => view.detection?.state === state).length;
  const delays = (list: typeof views) =>
    list.flatMap((view) =>
      view.detection?.detectedAt
        ? [view.detection.detectedAt - view.startedAt]
        : [],
    );
  const mean = (values: number[]) =>
    values.length
      ? Math.round(
          values.reduce((sum, value) => sum + value, 0) / values.length,
        )
      : null;
  const matched = new Set(
    views.flatMap((view) =>
      view.detection?.caseId ? [view.detection.caseId] : [],
    ),
  );
  const unmatched = (cases ?? []).filter(
    (item) =>
      !matched.has(item.id) &&
      Date.parse(item.detectedAt) >= run.state.startedAt,
  );
  const { rows: duplicates } = await pool.query<{
    instance: string;
    operation: string;
    key: string;
    count: number;
  }>(
    `SELECT instance, operation, key, count FROM sim_writes WHERE run_id = $1 AND count > 1 ORDER BY count DESC LIMIT 50`,
    [run.id],
  );

  return {
    generatedAt: Date.now(),
    luma: { connected: cases !== null, error },
    totals: {
      incidents: views.length,
      detected: count('detected'),
      missed: count('missed'),
      pending: count('pending'),
      notCovered: views.filter((view) => !view.expected.exceptionClass).length,
      falsePositives: unmatched.length,
      closedWithoutVerification: (cases ?? []).filter(
        (item) => item.closedWithoutVerification,
      ).length,
      duplicateWrites: duplicates.length,
    },
    meanTimeToDetectMs: mean(delays(views)),
    byKind: Object.entries(incidentKinds).map(([kind, definition]) => {
      const list = views.filter((view) => view.kind === kind);

      return {
        kind,
        label: definition.label,
        exceptionClass: definition.exceptionClass,
        total: list.length,
        detected: count('detected', list),
        missed: count('missed', list),
        pending: count('pending', list),
        notCovered: definition.exceptionClass ? 0 : list.length,
        meanTimeToDetectMs: mean(delays(list)),
      };
    }),
    falsePositives: unmatched.map((item) => ({
      id: item.id,
      exceptionClass: item.exceptionClass,
      detectedAt: item.detectedAt,
      url: item.url,
    })),
    duplicateWrites: duplicates.map((row) => ({
      ...row,
      count: Number(row.count),
    })),
  };
}
