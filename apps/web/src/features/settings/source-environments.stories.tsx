import type { ApiClient } from '@luma/api-contract/client';
import { m } from '@luma/i18n/messages';
import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { contextFixture } from '../../kit/identity/context.fixture';
import { contextOptions } from '../../kit/identity/data';
import appStyles from '../../styles.css?inline';
import { SourceEnvironmentSettings } from './source-environments';

const organizationId = '11111111-1111-4111-8111-111111111111';
const connectionId = '33333333-3333-4333-8333-333333333333';
const actorId = '22222222-2222-4222-8222-222222222222';

type Item = Awaited<
  ReturnType<ApiClient['sourceEnvironments']['list']>
>['items'][number];

type Declaration = NonNullable<Item['declaration']>;

type State =
  | 'ready'
  | 'lost'
  | 'expired'
  | 'changed'
  | 'offline'
  | 'denied'
  | 'unsupported';

let commands: Record<string, unknown>[] = [];

function mock(state: State) {
  commands = [];
  const at = new Date().toISOString();
  const review = {
    id: '44444444-4444-4444-8444-444444444444',
    connectionId,
    sourceBinding: 'reviewed-source-binding',
    connectionVersion: 4,
    credentialVersion: 2,
    actorId,
    observedAt: at,
    expiresAt: new Date(
      Date.now() + (state === 'expired' ? -1000 : 300_000),
    ).toISOString(),
    observations: [
      {
        id: 'purchase-order-observation',
        provider: 'JTL-Wawi',
        resource: 'purchase-orders',
        sourceRevision: 'orders-v8',
        observedAt: at,
      },
    ],
  };
  const declaration: Declaration = {
    connectionId,
    revision: 1,
    review,
    revoked: false,
    actorId,
    reason: 'Reviewed real operational use',
    at,
  };
  let current: Item = {
    connectionId,
    label: 'Warehouse operations',
    reviewable: state !== 'unsupported',
    reviewBlock: state === 'unsupported' ? 'missing_capability' : null,
    environment: 'unknown',
    provenance: null,
    declaration: ['changed', 'unsupported'].includes(state)
      ? declaration
      : null,
  };
  const receipts = new Map<string, Declaration>();
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request =
      input instanceof Request
        ? input
        : new Request(new URL(String(input), location.origin), init);
    const path = new URL(request.url).pathname;
    if (path.endsWith('/context'))
      return Response.json(
        contextFixture(organizationId, {
          name: 'Connection manager',
          permissions: ['connections.manage'],
        }),
      );
    if (path.endsWith('/source-environments')) {
      if (state === 'denied')
        return Response.json(
          { code: 'FORBIDDEN', message: 'No longer authorized' },
          { status: 403 },
        );

      return Response.json({
        available: true,
        items: [
          current,
          {
            connectionId: '55555555-5555-4555-8555-555555555555',
            label: 'Synthetic pilot',
            reviewable: false,
            reviewBlock: 'synthetic',
            environment: 'synthetic',
            provenance: {
              basis: 'simulation_manifest',
              connectionId: '55555555-5555-4555-8555-555555555555',
              connectionVersion: 1,
              credentialVersion: 1,
              sourceBinding: 'trusted-simulator',
              declarationRevision: null,
              evidenceId: null,
            },
            declaration: null,
          },
        ],
      });
    }
    if (path.endsWith(`/${connectionId}/review`)) return Response.json(review);
    if (path.endsWith(`/source-environments/${connectionId}`)) {
      const body = await request.json();
      commands.push(body);
      const saved = receipts.get(body.commandId) ?? {
        ...declaration,
        revision: (current.declaration?.revision ?? 0) + 1,
        revoked: !body.liveOperationsConfirmed,
        reason: body.reason,
      };
      receipts.set(body.commandId, saved);
      current = {
        ...current,
        environment: saved.revoked ? 'unknown' : 'live',
        provenance: saved.revoked
          ? null
          : {
              basis: 'reviewed_workspace_declaration',
              connectionId,
              connectionVersion: review.connectionVersion,
              credentialVersion: review.credentialVersion,
              sourceBinding: review.sourceBinding,
              declarationRevision: saved.revision,
              evidenceId: review.id,
            },
        declaration: saved,
      };
      if (state === 'lost' && commands.length === 1)
        throw new TypeError('Response lost after commit');

      return Response.json(saved);
    }

    return original(input, init);
  };
  onlineManager.setOnline(state !== 'offline');

  return () => {
    globalThis.fetch = original;
    onlineManager.setOnline(true);
  };
}

function Preview() {
  const [client] = useState(() => {
    const value = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    // A connection manager can review sources without permission to change approval policies.
    value.setQueryData(
      contextOptions(organizationId).queryKey,
      contextFixture(organizationId, {
        name: 'Connection manager',
        permissions: ['connections.manage'],
      }),
    );

    return value;
  });

  return (
    <QueryClientProvider client={client}>
      <style>{appStyles}</style>
      <main className="settings-content">
        <SourceEnvironmentSettings organizationId={organizationId} />
      </main>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Settings/Source operational use',
  component: Preview,
  beforeEach: () => mock('ready'),
} satisfies Meta<typeof Preview>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Sources: Story = {};

export const ReviewedDeclaration: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const inspect = await canvas.findByRole('button', {
      name: m.settings_source_inspect(),
    });
    await userEvent.click(inspect);
    await waitFor(() =>
      expect(
        canvas.getByText(m.settings_source_evidence(), { exact: false }),
      ).toBeVisible(),
    );
    const save = canvas.getByRole('button', {
      name: m.settings_source_declare(),
    });
    await expect(save).toBeDisabled();
    await userEvent.click(
      canvas.getByText(m.settings_source_evidence_details()),
    );
    await expect(canvas.getByText('orders-v8')).toBeVisible();
    await userEvent.click(
      await canvas.findByRole('checkbox', {
        name: m.settings_source_confirm(),
      }),
    );
    await userEvent.type(
      canvas.getByLabelText(m.settings_autonomy_reason()),
      'Reviewed production warehouse use',
    );
    save.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(canvas.getByText(m.settings_source_saved())).toBeVisible(),
    );
    await expect(commands[0]).toMatchObject({
      expectedRevision: 0,
      reviewId: '44444444-4444-4444-8444-444444444444',
      liveOperationsConfirmed: true,
      reason: 'Reviewed production warehouse use',
    });
    await userEvent.type(
      canvas.getByLabelText(m.settings_autonomy_reason()),
      'No longer used for live operations',
    );
    await userEvent.click(
      canvas.getByRole('button', { name: m.settings_source_revoke() }),
    );
    await waitFor(() =>
      expect(
        canvas.getByText(m.settings_source_revoked(), { exact: true }),
      ).toBeVisible(),
    );
    await expect(commands[1]).toMatchObject({
      expectedRevision: 1,
      reviewId: null,
      liveOperationsConfirmed: false,
    });
    await expect(canvas.getByText(m.settings_source_synthetic())).toBeVisible();
  },
};

export const LostResponse: Story = {
  beforeEach: () => mock('lost'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: m.settings_source_inspect() }),
    );
    await userEvent.click(
      await canvas.findByRole('checkbox', {
        name: m.settings_source_confirm(),
      }),
    );
    await userEvent.type(
      canvas.getByLabelText(m.settings_autonomy_reason()),
      'Reviewed real order evidence',
    );
    await userEvent.click(
      canvas.getByRole('button', { name: m.settings_source_declare() }),
    );
    await waitFor(() =>
      expect(canvas.getByText(m.settings_source_uncertain())).toBeVisible(),
    );
    await waitFor(() =>
      expect(canvas.getByText(m.settings_source_live())).toBeVisible(),
    );
    await expect(
      canvas.getByLabelText(m.settings_autonomy_reason()),
    ).toBeDisabled();
    await userEvent.click(
      canvas.getByRole('button', { name: m.settings_source_check_saved() }),
    );
    await waitFor(() => expect(commands).toHaveLength(2));
    await expect(commands[1]).toEqual(commands[0]);
    await waitFor(() =>
      expect(canvas.getByText(m.settings_source_saved())).toBeVisible(),
    );
  },
};

export const ExpiredReview: Story = {
  beforeEach: () => mock('expired'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: m.settings_source_inspect() }),
    );
    await waitFor(() =>
      expect(
        canvas.getByText(m.settings_source_review_expired()),
      ).toBeVisible(),
    );
    await expect(canvas.getByRole('checkbox')).toBeDisabled();
    await expect(
      canvas.getByRole('button', { name: m.settings_source_declare() }),
    ).toBeDisabled();
    await expect(commands).toHaveLength(0);
  },
};

export const ChangedSource: Story = { beforeEach: () => mock('changed') };

export const Offline: Story = { beforeEach: () => mock('offline') };

export const AccessLost: Story = { beforeEach: () => mock('denied') };

export const UnsupportedSource: Story = {
  beforeEach: () => mock('unsupported'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(
        canvas.getByText(m.settings_source_missing_capability()),
      ).toBeVisible(),
    );
    await expect(
      canvas.getByRole('button', { name: m.settings_source_inspect() }),
    ).toBeDisabled();
    await expect(commands).toHaveLength(0);
    await userEvent.type(
      canvas.getByLabelText(m.settings_autonomy_reason()),
      'Revoke unavailable source declaration',
    );
    await userEvent.click(
      canvas.getByRole('button', { name: m.settings_source_revoke() }),
    );
    await waitFor(() => expect(commands).toHaveLength(1));
    await expect(commands[0]).toMatchObject({
      reviewId: null,
      liveOperationsConfirmed: false,
      expectedRevision: 1,
    });
  },
};
