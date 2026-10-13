import {
  createIdentity,
  createMorningBriefReader,
} from '@luma/identity/composition';
import { expect, it, vi } from 'vitest';

import { seedResolutionMeasurement } from './resolution-measurement-fixture.mjs';
import { settingsFixture } from './settings-fixture.mjs';

async function optedIn(t) {
  const f = await settingsFixture(t, 'http://localhost:3000', {
    morningBriefEnabled: async () => true,
  });
  await f.request(
    f.member,
    `${f.base}/settings/notifications`,
    'PATCH',
    f.command({
      revision: 0,
      issues: false,
      connections: false,
      morningBrief: true,
      morningBriefTime: '00:00',
    }),
  );
  const read = vi.fn(async (_context, end, start) => ({
    start: start.toISOString(),
    end: end.toISOString(),
    attention: 1,
    active: 2,
    verified: 1,
    partial: false,
    decisions: [
      {
        label: 'Review the correction',
        link: `http://localhost:3000/app/${f.org.id}/needs-you?item=case%3A1`,
      },
    ],
    cases: [
      {
        label: 'Executed, awaiting independent verification',
        verified: false,
        link: `http://localhost:3000/app/${f.org.id}/exceptions/1/detail`,
      },
      {
        label: 'Stock comparison passed',
        verified: true,
        link: `http://localhost:3000/app/${f.org.id}/exceptions/2/detail`,
      },
    ],
  }));
  const source = { enabled: async () => true, read };

  return {
    ...f,
    read,
    source,
    schedule: f.identity.morningBriefScheduler(source),
  };
}

it('queues once per member/local day across concurrent schedulers, restart and uncertain delivery', async (t) => {
  const f = await optedIn(t);
  await f.request(
    f.member,
    '/v1/account/language',
    'PUT',
    { language: 'de' },
    204,
  );
  await Promise.all([f.schedule(), f.schedule()]);
  const restarted = createIdentity(f.config);
  t.onTestFinished(() => restarted.close());
  await restarted.morningBriefScheduler(f.source)();
  const rows = (
    await f.db.owner.query(
      "SELECT * FROM workspace_mail WHERE kind='morning_brief'",
    )
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    user_id: f.member.id,
    state: 'queued',
    attempts: 0,
  });
  expect(f.read.mock.calls[0][0].actor.id).toBe(f.member.id);
  expect(new Date(rows[0].brief_document.content.start).getUTCHours()).toBe(0);
  f.setFail(true);
  await f.drain();
  expect(f.messages.size).toBe(0);
  await f.db.owner.query(
    "UPDATE workspace_mail SET next_attempt_at=now() WHERE kind='morning_brief'",
  );
  f.setFail(false);
  await restarted.mailDelivery.drain();
  expect(f.messages.size).toBe(1);
  const delivered = f.messages.get(rows[0].id);
  expect(delivered.subject).toBe('Morgenüberblick · Northstar');
  expect(delivered.text).toContain('Unabhängig verifizierte Fälle');
  expect(delivered.text).toContain(
    'Laufend: Executed, awaiting independent verification',
  );
  expect(delivered.text).toContain('Verifiziert: Stock comparison passed');
  expect(delivered.text).toContain(`/app/${f.org.id}/needs-you?item=case%3A1`);
  await f.schedule();
  await f.drain();
  expect(f.messages.size).toBe(1);
});

it('skips empty days and retries unavailable reads without inventing results', async (t) => {
  const f = await optedIn(t);
  f.read.mockRejectedValueOnce(new Error('Reader unavailable'));
  await expect(f.schedule()).rejects.toThrow('Reader unavailable');
  expect(
    (
      await f.db.owner.query(
        "SELECT * FROM workspace_mail WHERE kind='morning_brief'",
      )
    ).rows,
  ).toHaveLength(0);
  f.read.mockResolvedValue(null);
  await f.schedule();
  await f.schedule();
  expect(
    (
      await f.db.owner.query(
        "SELECT state FROM workspace_mail WHERE kind='morning_brief'",
      )
    ).rows,
  ).toEqual([{ state: 'cancelled' }]);
  expect(f.read).toHaveBeenCalledTimes(2);
  await f.drain();
  expect(f.messages.size).toBe(0);
});

it('rechecks opt-out, access changes, workspace state and the release before dispatch', async (t) => {
  const f = await optedIn(t);
  await f.schedule();
  await f.request(
    f.member,
    `${f.base}/settings/notifications`,
    'PATCH',
    f.command({
      revision: 1,
      issues: false,
      connections: false,
      morningBrief: false,
      morningBriefTime: '00:00',
    }),
  );
  await f.drain();
  expect(f.messages.size).toBe(0);
  await f.db.owner.query(
    "DELETE FROM workspace_mail WHERE kind='morning_brief'",
  );
  await f.request(
    f.member,
    `${f.base}/settings/notifications`,
    'PATCH',
    f.command({
      revision: 2,
      issues: false,
      connections: false,
      morningBrief: true,
      morningBriefTime: '00:00',
    }),
  );
  await f.schedule();
  await f.request(f.owner, `${f.base}/members/${f.membership.id}`, 'PATCH', {
    roleId: 'admin',
  });
  await f.drain();
  expect(f.messages.size).toBe(0);
  expect(
    (
      await f.db.owner.query(
        "SELECT state FROM workspace_mail WHERE kind='morning_brief'",
      )
    ).rows,
  ).toEqual([{ state: 'cancelled' }]);
  await f.db.owner.query(
    "DELETE FROM workspace_mail WHERE kind='morning_brief'",
  );
  await f.schedule();
  const disabled = createIdentity({
    ...f.config,
    morningBriefEnabled: async () => false,
  });
  t.onTestFinished(() => disabled.close());
  await disabled.mailDelivery.drain();
  expect(f.messages.size).toBe(0);
});

it('honors chosen local time, repeated and skipped DST hours, and retains the previous prepared boundary', async (t) => {
  const f = await optedIn(t);
  await f.request(
    f.owner,
    `${f.base}/settings/workspace`,
    'PATCH',
    f.command({ revision: 0, name: f.org.name, timezone: 'Europe/Berlin' }),
  );
  await f.request(
    f.member,
    `${f.base}/settings/notifications`,
    'PATCH',
    f.command({
      revision: 1,
      issues: false,
      connections: false,
      morningBrief: true,
      morningBriefTime: '02:30',
    }),
  );
  await f.schedule(new Date('2026-10-25T00:29:00Z'));
  expect(f.read).not.toHaveBeenCalled();
  await f.schedule(new Date('2026-10-25T00:30:00Z'));
  await f.schedule(new Date('2026-10-25T01:30:00Z'));
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.read.mock.calls[0][2].toISOString()).toBe(
    '2026-10-23T22:00:00.000Z',
  );
  await f.schedule(new Date('2026-10-26T01:30:00Z'));
  expect(f.read.mock.calls[1][2].toISOString()).toBe(
    '2026-10-25T00:30:00.000Z',
  );
  await f.db.owner.query(
    "DELETE FROM workspace_mail WHERE kind='morning_brief'",
  );
  f.read.mockClear();
  await f.schedule(new Date('2026-03-29T01:00:00Z'));
  expect(f.read).toHaveBeenCalledTimes(1);
  expect(f.read.mock.calls[0][2].toISOString()).toBe(
    '2026-03-27T23:00:00.000Z',
  );
});

it('matches Home for the frozen window and counts independent verification rather than execution', async (t) => {
  const f = await optedIn(t);
  const verified = await seedResolutionMeasurement(f);
  const pending = await seedResolutionMeasurement(f, { verified: false });
  f.source.read = createMorningBriefReader({
    origin: 'http://localhost:3000',
    decisions: () =>
      f.request(f.member, `${f.base}/decisions?view=all&limit=5`),
    overview: (_context, end, start) =>
      f.request(
        f.member,
        `${f.base}/operations/overview?window=24h&start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`,
      ),
    active: () =>
      f.request(f.member, `${f.base}/exceptions?view=active&limit=5`),
  });
  await f.schedule();
  const document = (
    await f.db.owner.query(
      "SELECT brief_document FROM workspace_mail WHERE kind='morning_brief'",
    )
  ).rows[0].brief_document.content;
  const overview = await f.request(
    f.member,
    `${f.base}/operations/overview?window=24h&start=${encodeURIComponent(document.start)}&end=${encodeURIComponent(document.end)}`,
  );
  expect(document).toMatchObject({
    active: overview.activeCount,
    verified: overview.verifiedResolutions,
  });
  expect(document.verified).toBe(1);
  expect(
    document.cases.find((item) => item.link.includes(verified.id)).verified,
  ).toBe(true);
  expect(
    document.cases.find((item) => item.link.includes(pending.id)).verified,
  ).toBe(false);
  expect(overview.measurement).toBeUndefined();
  await f.drain();
  const delivered = [...f.messages.values()][0];
  expect(delivered.text).toContain('Cases independently verified');
  expect(delivered.text).toContain(
    `/home?start=${encodeURIComponent(document.start)}&end=${encodeURIComponent(document.end)}`,
  );
});
