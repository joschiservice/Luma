import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function waitFor(check, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      // A worker replacement can briefly make Temporal queries unavailable.
      if (![1, 4, 14].includes(error.cause?.code)) throw error;
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for pilot state');
}

export async function respond(pilot, manifest, client, kind) {
  const actor = await pilot.operator();
  const id = manifest.incidents.workflow_failure;
  const review = await pilot.desk.review(actor, id);
  const receipt = await pilot.desk.decide(actor, id, {
    commandId: randomUUID(),
    kind,
    caseRevision: review.caseRevision,
    diagnosisRevision: review.diagnosisRevision,
    proposalId: review.proposal.id,
    proposalVersion: review.proposal.version,
    decisionId: review.proposal.policy.id,
    reason: `Synthetic pilot ${kind}`,
  });
  await client.notifyApproval(actor, { kind: 'incident', id });
  return receipt;
}

export async function startJourney(pilot, manifest, client) {
  if (
    ['healthy', 'diagnosis-pending', 'decisions-needed', 'uncertain'].includes(
      manifest.scenario,
    )
  )
    return;
  const actor = await pilot.context();
  const source = { kind: 'incident', id: manifest.incidents.workflow_failure };
  await client.start(actor, source);
  const progress = await waitFor(async () => {
    const progress = await client.progress(actor, source);
    if (
      ['awaiting_approval', 'resolved', 'denied', 'escalated'].includes(
        progress?.phase,
      )
    )
      return progress;
    const review = await pilot.desk.review(await pilot.operator(), source.id);
    return review.proposal?.approval ? progress : null;
  });
  if (manifest.scenario === 'approval-required') return;
  // A restarted worker resumes existing approval/execution; never manufacture a second response.
  const review = await pilot.desk.review(await pilot.operator(), source.id);
  if (progress.phase === 'awaiting_approval' && !review.proposal.approval)
    await respond(
      pilot,
      manifest,
      client,
      manifest.scenario === 'rejected' ? 'reject' : 'approve',
    );
}
