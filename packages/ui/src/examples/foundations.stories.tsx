import type { Meta, StoryObj } from '@storybook/react-vite';

const surfaces = [
  ['background', 'foreground'],
  ['card', 'card-foreground'],
  ['popover', 'popover-foreground'],
  ['primary', 'primary-foreground'],
  ['secondary', 'secondary-foreground'],
  ['muted', 'muted-foreground'],
  ['accent', 'accent-foreground'],
  ['destructive', 'destructive-foreground'],
  ['status-warning-surface', 'status-warning'],
  ['status-success-surface', 'status-success'],
  ['status-info-surface', 'status-info'],
  ['sidebar', 'sidebar-foreground'],
] as const;
const accents = [
  'primary-hover',
  'brand',
  'sidebar-brand',
  'border',
  'input',
  'ring',
  'overlay',
];

const radii = [
  ['sm', 'rounded-sm'],
  ['md', 'rounded-md'],
  ['lg', 'rounded-lg'],
  ['xl', 'rounded-xl'],
] as const;

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
      <h1 style={{ font: '36px/1.2 var(--font-heading)', marginBottom: 16 }}>
        Luma foundations
      </h1>
      <p style={{ marginBottom: 32 }}>
        Cool neutrals, spectral accents, and glass surfaces. Switch the theme to
        compare light and dark appearances.
      </p>
      <section aria-labelledby="surfaces-heading">
        <h2 id="surfaces-heading" style={{ fontSize: 24, marginBottom: 16 }}>
          Surfaces and text
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 16,
          }}
        >
          {surfaces.map(([surface, foreground]) => (
            <div
              key={surface}
              style={{
                padding: 20,
                minHeight: 116,
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                background: `var(--${surface})`,
                color: `var(--${foreground})`,
              }}
            >
              <h3 style={{ fontWeight: 600, marginBottom: 12 }}>{surface}</h3>
              <p style={{ fontSize: 14 }}>{foreground}</p>
            </div>
          ))}
        </div>
      </section>
      <section aria-labelledby="accents-heading" style={{ marginTop: 32 }}>
        <h2 id="accents-heading" style={{ fontSize: 24, marginBottom: 16 }}>
          Accents and boundaries
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: 16,
          }}
        >
          {accents.map((token) => (
            <div key={token}>
              <div
                aria-hidden="true"
                style={{
                  height: 56,
                  background: `var(--${token})`,
                  borderRadius: 'var(--radius)',
                  border: '1px solid var(--border)',
                  marginBottom: 8,
                }}
              />
              <p>{token}</p>
            </div>
          ))}
        </div>
      </section>
      <section aria-labelledby="type-heading" style={{ marginTop: 32 }}>
        <h2 id="type-heading" style={{ fontSize: 24, marginBottom: 16 }}>
          Typography
        </h2>
        <p style={{ font: '32px/1.2 var(--font-heading)', marginBottom: 12 }}>
          Room for a clearer working day.
        </p>
        <p style={{ font: '16px/1.6 var(--font-sans)' }}>
          Review the evidence. Understand the proposed action. Follow the
          outcome.
        </p>
        <p style={{ marginTop: 12, fontSize: 14 }}>
          Interface: Inter. Numbers: IBM Plex Mono. Fonts are served locally
          with the application.
        </p>
      </section>
      <section aria-labelledby="radii-heading" style={{ marginTop: 32 }}>
        <h2 id="radii-heading" style={{ fontSize: 24, marginBottom: 16 }}>
          Corner radii
        </h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          {radii.map(([size, className]) => (
            <div
              key={size}
              className={className}
              style={{
                padding: 24,
                border: '1px solid var(--border)',
                background: 'var(--card)',
                color: 'var(--card-foreground)',
              }}
            >
              radius-{size}
            </div>
          ))}
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

export const Light: Story = {
  globals: { theme: 'light' },
};

export const Dark: Story = {
  globals: { theme: 'dark' },
};
