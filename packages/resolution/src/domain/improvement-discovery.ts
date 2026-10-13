import type { MeasurementSource } from './measurement.js';
import { classifyResolution } from './measurement.js';

/** One distinct incident's retained, verified resolution selection and measured involvement. */
export interface ImprovementDiscoverySource {
  measurement: MeasurementSource;
  runId: string;
  subjectId: string;
  artifact: { id: string; version: string; digest: string };
  humanInterventions: number;
  humanEdits: number;
  effortSeconds: number | null;
  recurrences: number;
}

/** A review queue item; its counts identify repeated work and grant no promotion authority. */
export interface ImprovementDiscoveryGroup {
  id: string;
  pattern: 'inventory_mismatch' | 'sync_failure';
  artifact: ImprovementDiscoverySource['artifact'];
  environment: 'live' | 'synthetic' | 'unknown';
  verifiedIncidents: number;
  humanInterventions: number;
  humanEdits: number;
  recordedEffortSeconds: number | null;
  recurrences: number;
  eligibleForProposal: boolean;
  productionPromotion: 'blocked';
  missingEvidence: string[];
  sources: { incidentId: string; runId: string; subjectId: string }[];
}

/**
 * Clusters distinct, independently verified incidents by exact artifact, pattern and environment.
 * Three incidents and repeated human involvement make a review candidate, never an automatic
 * optimization. Synthetic and unknown cohorts cannot contribute to real-volume evidence.
 */
export function discoverImprovements(
  sources: ImprovementDiscoverySource[],
  asOf: string,
  hash: (value: unknown) => string,
): ImprovementDiscoveryGroup[] {
  const grouped = new Map<
    string,
    {
      group: ImprovementDiscoveryGroup;
      incidents: Set<string>;
      effortKnown: boolean;
    }
  >();
  for (const source of sources) {
    const measured = classifyResolution(source.measurement, asOf);
    const pattern = source.measurement.title;
    if (
      measured.outcome !== 'verified' ||
      (pattern !== 'inventory_mismatch' && pattern !== 'sync_failure')
    )
      continue;
    const environment =
      measured.environment === 'live'
        ? 'live'
        : measured.environment === 'synthetic' ||
            measured.environment === 'pilot'
          ? 'synthetic'
          : 'unknown';
    const id = hash({ pattern, artifact: source.artifact, environment });
    let entry = grouped.get(id);
    if (!entry) {
      entry = {
        group: {
          id,
          pattern,
          artifact: source.artifact,
          environment,
          verifiedIncidents: 0,
          humanInterventions: 0,
          humanEdits: 0,
          recordedEffortSeconds: 0,
          recurrences: 0,
          eligibleForProposal: false,
          productionPromotion: 'blocked',
          missingEvidence: [],
          sources: [],
        },
        incidents: new Set(),
        effortKnown: true,
      };
      grouped.set(id, entry);
    }
    if (entry.incidents.has(measured.id)) continue;
    entry.incidents.add(measured.id);
    entry.group.verifiedIncidents++;
    entry.group.humanInterventions += source.humanInterventions;
    entry.group.humanEdits += source.humanEdits;
    entry.group.recurrences += source.recurrences;
    if (source.effortSeconds === null) entry.effortKnown = false;
    else
      entry.group.recordedEffortSeconds =
        (entry.group.recordedEffortSeconds ?? 0) + source.effortSeconds;
    entry.group.sources.push({
      incidentId: measured.id,
      runId: source.runId,
      subjectId: source.subjectId,
    });
  }

  return [...grouped.values()]
    .map(({ group, effortKnown }) => ({
      ...group,
      recordedEffortSeconds: effortKnown ? group.recordedEffortSeconds : null,
      eligibleForProposal:
        group.verifiedIncidents >= 3 &&
        group.humanInterventions + group.humanEdits >= 2,
      missingEvidence: [
        ...(group.environment !== 'live' ? ['real_run_volume'] : []),
        ...(group.verifiedIncidents < 3 ? ['recurring_pattern_volume'] : []),
        'trusted_historical_replay',
        'reviewed_candidate',
        'two_real_patterns',
      ],
      sources: group.sources.sort((left, right) =>
        left.incidentId.localeCompare(right.incidentId),
      ),
    }))
    .sort(
      (left, right) =>
        right.humanInterventions +
          right.humanEdits -
          (left.humanInterventions + left.humanEdits) ||
        left.id.localeCompare(right.id),
    );
}
