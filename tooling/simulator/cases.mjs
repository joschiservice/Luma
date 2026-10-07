const maxCases = 500;

/** Collects provider record IDs from evidence facts, for matching cases to simulator records. */
function identifiers(value, found = new Set(), depth = 0) {
  if (depth > 6 || value === null || value === undefined) return found;
  if (typeof value === 'string') {
    if (value.length <= 200) found.add(value);

    return found;
  }
  if (typeof value !== 'object') return found;
  for (const item of Object.values(value)) identifiers(item, found, depth + 1);

  return found;
}

/**
 * Lists the workspace's cases with the simulator instances and provider IDs in their evidence,
 * and the latest workflow run each case started, for the simulator scorecard. Reads through the
 * authorized detection and workflow services.
 */
export async function lumaCases(
  context,
  { detection, workflows, manifest, webOrigin },
) {
  const instances = new Map(
    Object.entries(manifest.connections).map(([name, id]) => [id, name]),
  );
  const incidents = (await detection.exceptions.list(context)).slice(-maxCases);
  // The newest run per case; runs come newest first.
  const runs = new Map();
  for (const run of (await workflows?.caseRuns(context)) ?? [])
    if (!runs.has(run.caseId)) runs.set(run.caseId, run);

  return Promise.all(
    incidents.map(async (incident) => {
      const evidence = await detection.exceptions.evidence(
        context,
        incident.id,
      );
      const found = identifiers([
        incident.subject,
        evidence.map((item) => [item.source, item.facts]),
      ]);
      const connections = new Set([
        ...evidence.map((item) => item.connectionId),
        ...incident.subject.scope,
        incident.subject.subjectId,
      ]);
      const resolution = incident.resolution;
      const verified =
        resolution?.kind === 'verification' &&
        resolution.outcome === 'passed' &&
        resolution.complete &&
        resolution.authoritative;

      return {
        id: incident.id,
        exceptionClass: incident.exceptionClass,
        detectedAt: incident.firstDetectedAt,
        resolvedAt:
          incident.state === 'resolved' ? (resolution?.at ?? null) : null,
        closedWithoutVerification:
          incident.state === 'resolved' &&
          resolution?.kind === 'verification' &&
          !verified,
        verified: !!verified,
        instances: [...connections].flatMap((id) =>
          instances.has(id) ? [instances.get(id)] : [],
        ),
        identifiers: [...found],
        url: `${webOrigin}/app/${manifest.organizationId}/exceptions/${incident.id}`,
        workflow: runs.has(incident.id)
          ? {
              name: runs.get(incident.id).name,
              state: runs.get(incident.id).state ?? 'starting',
              url: `${webOrigin}/app/${manifest.organizationId}/workflows/${runs.get(incident.id).definitionId}#run-${runs.get(incident.id).runId}`,
            }
          : null,
      };
    }),
  );
}
