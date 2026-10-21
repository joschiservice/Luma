import { expect, test } from 'vitest';

import { until } from './helpers.mjs';
import {
  quantityChangeFixture,
  workflow,
} from './order-quantity-change-fixture.mjs';

test('hands a started pick to the warehouse, survives a worker restart while waiting, and edits Shopify only after fresh reads show the pick was reset', async (t) => {
  const f = await quantityChangeFixture(t);
  await f.activate(workflow);
  await f.packing();
  await f.changeQuantity('1');
  const opened = await f.caseOpened();
  const run = await f.run();
  const waiting = await f.waitFor(workflow, run.id, 'waiting');
  expect(
    waiting.processSteps.find((step) => step.stepId === 'plan'),
  ).toMatchObject({
    values: { ready: true, workStarted: true, targetQuantity: 1 },
  });

  // The worker is replaced while the task waits; the wait and its task survive.
  await f.restartWorker();
  await f.wake(run.id);
  expect((await f.task(run.id)).state).toBe('open');
  expect(
    (await f.waitFor(workflow, run.id, 'waiting')).processSteps.filter(
      (step) => step.stepId === 'dispatch',
    ),
  ).toHaveLength(1);

  // The warehouse stops packing and removes the delivery note, then answers.
  await f.unpack();
  await f.answer(run.id, 'Adjusted');
  await f.approve(run.id);
  const verified = await f.waitFor(workflow, run.id, 'verified');
  expect(
    verified.processSteps.find((step) => step.stepId === 'replan'),
  ).toMatchObject({
    values: { safe: true, workStarted: false, shopifyDiffers: true },
  });
  expect(await f.commits()).toHaveLength(1);
  await until(async () => {
    await f.pilot.detect();

    return (
      (await f.pilot.detection.exceptions.get(f.actor, opened.id)).state ===
      'resolved'
    );
  }, 'detection verifies the case');
}, 300_000);

test('a missed warehouse deadline escalates the task to admins, and an answer fresh reads contradict hands the case to its owner', async (t) => {
  const f = await quantityChangeFixture(t);
  await f.activate(workflow);
  await f.packing();
  await f.changeQuantity('1');
  const opened = await f.caseOpened();
  const run = await f.run();
  await f.waitFor(workflow, run.id, 'waiting');
  expect(
    (
      await f.request('/decisions', undefined, { cookie: f.warehouseCookie })
    ).items.some((item) => item.kind === 'human_task'),
  ).toBe(true);

  // Four hours pass without an answer.
  await f.db.owner.query(
    "UPDATE workflow_human_tasks SET document=jsonb_set(document,'{dueAt}',to_jsonb($3::text)) WHERE tenant_id=$1 AND run_id=$2",
    [
      f.manifest.organizationId,
      run.id,
      new Date(Date.now() - 60_000).toISOString(),
    ],
  );
  await f.wake(run.id);
  const escalated = await until(async () => {
    const task = await f.task(run.id, f.operatorCookie);

    return task.escalatedAt ? task : null;
  }, 'the overdue task escalates to admins');
  expect(escalated.assignee).toEqual({ kind: 'role', key: 'admin' });
  const queue = await f.request('/decisions');
  expect(queue.items).toContainEqual(
    expect.objectContaining({
      kind: 'human_task',
      why: 'The task is overdue and has been assigned to its fallback.',
      record: { kind: 'order', id: f.shop },
    }),
  );
  expect(
    (
      await f.request('/decisions', undefined, { cookie: f.warehouseCookie })
    ).items.some((item) => item.kind === 'human_task'),
  ).toBe(false);
  // The case stays open with a responsible owner, and Needs you shows it with that owner.
  const current = await f.request(`/exceptions/${opened.id}`);
  expect(current.state).not.toBe('resolved');
  expect(current.owner).toMatchObject({ userId: f.manifest.operatorId });
  expect(queue.items).toContainEqual(
    expect.objectContaining({
      id: `case:${opened.id}`,
      assignment: expect.objectContaining({
        assigneeId: f.manifest.operatorId,
      }),
    }),
  );

  // An admin answers, but fresh reads still show packing: the answer is not proof.
  await f.answer(run.id, 'Adjusted', f.operatorCookie);
  const handed = await f.waitFor(workflow, run.id, 'escalated');
  expect(handed.processSteps.at(-1)).toMatchObject({
    stepId: 'safe-now',
    state: 'escalated',
  });
  expect(
    handed.processSteps.find((step) => step.stepId === 'replan'),
  ).toMatchObject({
    values: {
      safe: false,
      workStarted: true,
      problem: 'The warehouse has started work on this line.',
    },
  });
  const journal = await f.call(`runs/${f.manifest.simulator.runId}/journal`);
  expect(
    journal.items.filter((entry) =>
      JSON.stringify(entry).includes('orders.quantity.edit'),
    ),
  ).toEqual([]);
  expect(
    (await f.pilot.detection.exceptions.get(f.actor, opened.id)).state,
  ).not.toBe('resolved');
  expect((await f.request(`/exceptions/${opened.id}`)).owner).toMatchObject({
    userId: f.manifest.operatorId,
  });
}, 300_000);
