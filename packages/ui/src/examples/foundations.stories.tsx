import type { Meta, StoryObj } from '@storybook/react-vite';

import { AurenMark, LumaLockup } from '../components/primitives/brand';
import { type Domain, DomainIcon } from '../components/primitives/domain-icon';
import {
  type OperationalState,
  StatePill,
} from '../components/primitives/state';

const brand = [
  ['brand-canvas', 'Canvas'],
  ['brand-graphite', 'Graphite'],
  ['brand-deep', 'Deep Surface'],
  ['brand-midnight', 'Midnight'],
  ['brand-cobalt', 'Cobalt'],
  ['brand-azure', 'Azure'],
] as const;

const surfaces = [
  ['background', 'foreground', 'App background'],
  ['surface', 'foreground', 'Page surface'],
  ['surface-raised', 'foreground', 'Raised panel'],
  ['surface-sunken', 'foreground-muted', 'Sunken detail'],
  ['signal-soft', 'signal-text', 'Selection and activity'],
] as const;

const states: [OperationalState, string][] = [
  ['running', 'Applying fix'],
  ['approval', 'Needs approval'],
  ['attention', 'Needs review'],
  ['error', 'Action failed'],
  ['verified', 'Verified'],
  ['waiting', 'Fix proposed'],
  ['idle', 'Closed'],
];

const domains: Domain[] = [
  'orders',
  'inventory',
  'products',
  'returns',
  'procurement',
  'suppliers',
  'fulfillment',
  'workflows',
  'issues',
  'activity',
  'apps',
];

const section = { marginTop: 32 } as const;
const heading = { fontSize: 15, fontWeight: 600, marginBottom: 12 } as const;

function Foundations() {
  return (
    <main
      style={{
        maxWidth: 1040,
        margin: '0 auto',
        padding: 24,
        color: 'var(--foreground)',
        background: 'var(--background)',
      }}
    >
      <LumaLockup byAuren size="lg" />
      <h1
        style={{
          margin: '24px 0 8px',
          fontSize: 32,
          fontWeight: 500,
          letterSpacing: '-0.035em',
        }}
      >
        Luma foundations
      </h1>
      <p style={{ color: 'var(--foreground-muted)' }}>
        Living Systems: precise geometry, visible states, subtle depth and
        productivity first. Switch the theme to compare light and dark.
      </p>
      <section aria-labelledby="brand-heading" style={section}>
        <h2 id="brand-heading" style={heading}>
          Brand foundation
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: 8,
          }}
        >
          {brand.map(([token, name]) => (
            <div key={token}>
              <div
                aria-hidden="true"
                style={{
                  height: 64,
                  borderRadius: 12,
                  background: `var(--${token})`,
                  boxShadow: 'inset 0 0 0 1px var(--line)',
                }}
              />
              <p style={{ marginTop: 6, fontSize: 13, fontWeight: 500 }}>
                {name}
              </p>
            </div>
          ))}
        </div>
      </section>
      <section aria-labelledby="surfaces-heading" style={section}>
        <h2 id="surfaces-heading" style={heading}>
          Surfaces and text
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: 8,
          }}
        >
          {surfaces.map(([surface, foreground, label]) => (
            <div
              key={surface}
              style={{
                minHeight: 88,
                padding: 14,
                borderRadius: 12,
                background: `var(--${surface})`,
                color: `var(--${foreground})`,
                boxShadow: 'var(--shadow-panel)',
              }}
            >
              <strong style={{ fontSize: 13 }}>{label}</strong>
              <p style={{ marginTop: 4, fontSize: 12 }}>--{surface}</p>
            </div>
          ))}
        </div>
      </section>
      <section aria-labelledby="states-heading" style={section}>
        <h2 id="states-heading" style={heading}>
          Operational states
        </h2>
        <p style={{ marginBottom: 12, color: 'var(--foreground-muted)' }}>
          Brand blue marks active work; it never replaces a state color. Every
          state is paired with a label.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {states.map(([state, label]) => (
            <StatePill key={state} state={state}>
              {label}
            </StatePill>
          ))}
        </div>
      </section>
      <section aria-labelledby="domains-heading" style={section}>
        <h2 id="domains-heading" style={heading}>
          Domain landmarks
        </h2>
        <ul
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 16,
            padding: 0,
            listStyle: 'none',
          }}
        >
          {domains.map((domain) => (
            <li
              key={domain}
              style={{ display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <DomainIcon domain={domain} />
              <span style={{ fontSize: 13, textTransform: 'capitalize' }}>
                {domain}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="type-heading" style={section}>
        <h2 id="type-heading" style={heading}>
          Typography
        </h2>
        <p
          style={{
            fontSize: 40,
            fontWeight: 500,
            lineHeight: 1.05,
            letterSpacing: '-0.04em',
          }}
        >
          Spend less time fixing the same order problems
        </p>
        <p style={{ marginTop: 12, fontSize: 14 }}>
          Instrument Sans carries every role. Personality comes from scale,
          rhythm and space rather than a second display face.
        </p>
        <p
          style={{
            marginTop: 8,
            color: 'var(--foreground-subtle)',
            fontSize: 12,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          Tabular figures: 1,248 · 36m · 99.2%
        </p>
      </section>
      <section aria-labelledby="marks-heading" style={section}>
        <h2 id="marks-heading" style={heading}>
          Marks
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <LumaLockup />
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            <AurenMark />
            <strong>Auren</strong>
            <span style={{ color: 'var(--foreground-subtle)' }}>Labs</span>
          </span>
        </div>
      </section>
    </main>
  );
}

const meta = {
  title: 'Foundations/Theme',
  component: Foundations,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Foundations>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Light: Story = {};

export const Dark: Story = { globals: { theme: 'dark' } };
