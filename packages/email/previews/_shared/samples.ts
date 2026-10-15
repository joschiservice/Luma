import type { Email } from '../../src/index.js';

const origin = 'https://app.luma.example';
const workspace = 'Nordlicht Outdoor';
const tenant = '0b8f3c1e-5d2a-4c6b-9f1e-7a3d2c1b0e9f';
const timeZone = 'Europe/Berlin';
const preferencesLink = `${origin}/app/${tenant}/settings/notifications`;

/** Realistic sample data for every email, used by the preview server and the render tests. */
export const samples = {
  stock_protection: {
    kind: 'stock_protection',
    stage: 'placed',
    store: 'Shopify AU',
    workspace,
    preferencesLink,
    link: `${origin}/app/${tenant}/exceptions/9a7c5e3b-2d1f-4b8e-8c6a-4e2d0b9f7a5c/detail`,
  },
  morning_brief: {
    kind: 'morning_brief',
    workspace,
    timeZone,
    preferencesLink,
    start: '2026-10-11T06:00:00Z',
    end: '2026-10-12T06:00:00Z',
    attention: 2,
    active: 3,
    verified: 14,
    partial: true,
    decisions: [
      {
        label: 'Review stock correction',
        link: `${origin}/app/${tenant}/needs-you?item=case%3A123`,
      },
    ],
    cases: [
      {
        label: 'SKU 482',
        verified: true,
        link: `${origin}/app/${tenant}/exceptions/9a7c5e3b-2d1f-4b8e-8c6a-4e2d0b9f7a5c/detail`,
      },
    ],
    link: `${origin}/app/${tenant}/home?start=2026-10-11T06%3A00%3A00Z&end=2026-10-12T06%3A00%3A00Z`,
  },
  invitation: {
    kind: 'invitation',
    workspace,
    inviter: 'Mara Lindqvist',
    role: { builtIn: 'admin' },
    expiresAt: new Date('2026-10-19T09:30:00Z'),
    timeZone,
    link: `${origin}/app/invitations/${tenant}/5f0c2d7e-1b3a-4e8f-a6c9-2d4e8f1a3b5c#3b1f9c2e7d4a8b6c`,
  },
  test: { kind: 'test', workspace, preferencesLink },
  issue: {
    kind: 'issue',
    workspace,
    link: `${origin}/app/${tenant}/exceptions/9a7c5e3b-2d1f-4b8e-8c6a-4e2d0b9f7a5c/detail`,
    preferencesLink,
  },
  connection: {
    kind: 'connection',
    workspace,
    link: `${origin}/app/${tenant}/connections#connection-3c5e7a9b-1d2f-4a6c-8e0b-2d4f6a8c0e1b`,
    preferencesLink,
  },
  support_access_requested: {
    kind: 'support_access_requested',
    workspace,
    days: 3,
    reason:
      'Your team reported that stock updates to Shopify stopped on 9 October. We want to look at the sync history of the affected connection.',
    link: `${origin}/app/${tenant}/settings/support`,
  },
  support_view_started: {
    kind: 'support_view_started',
    workspace,
    member: 'Jonas Becker',
    startedAt: new Date('2026-10-12T08:05:00Z'),
    endsAt: new Date('2026-10-12T16:05:00Z'),
    timeZone,
    activityLink: `${origin}/app/${tenant}/activity`,
    endLink: `${origin}/app/${tenant}/settings/support`,
  },
  support_view_emergency: {
    kind: 'support_view_emergency',
    workspace,
    member: null,
    from: new Date('2026-10-11T22:40:00Z'),
    until: new Date('2026-10-11T23:15:00Z'),
    timeZone,
    activityLink: `${origin}/app/${tenant}/activity`,
  },
  password_reset: {
    kind: 'password_reset',
    link: `${origin}/reset-password#Xk2p9QmZ4vR7sT1w`,
  },
  password_changed: {
    kind: 'password_changed',
    resetLink: `${origin}/forgot-password`,
  },
  account_deletion_scheduled: {
    kind: 'account_deletion_scheduled',
    eraseAfter: new Date('2026-11-11T00:00:00Z'),
  },
  account_restored: {
    kind: 'account_restored',
    signInLink: `${origin}/sign-in`,
  },
  account_erased: { kind: 'account_erased' },
} satisfies { [K in Email['kind']]: Email & { kind: K } };
