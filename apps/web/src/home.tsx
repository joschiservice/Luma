import { LumaLockup } from '@luma/ui/components/primitives/brand';
import { StateDot } from '@luma/ui/components/primitives/state';

import { ResolutionStory } from './features/identity/story';

const loop = [
  { step: 'Detect', detail: 'Notice when work stops moving.', state: 'error' },
  {
    step: 'Diagnose',
    detail: 'Check the systems to find out why.',
    state: 'attention',
  },
  {
    step: 'Decide',
    detail: 'Choose a fix within agreed rules.',
    state: 'approval',
  },
  {
    step: 'Execute',
    detail: 'Make the change, with approval if needed.',
    state: 'running',
  },
  {
    step: 'Verify',
    detail: 'Confirm the intended outcome happened.',
    state: 'verified',
  },
] as const;

/** Renders the public entry page with sign-in and account creation links. */
export function Home() {
  return (
    <main className="landing">
      <header className="landing-bar">
        <a className="entry-brand" href="/" aria-label="Luma home">
          <LumaLockup byAuren />
        </a>
        <a className="landing-link" href="/sign-in">
          Sign in
        </a>
      </header>
      <section className="landing-hero" aria-labelledby="landing-title">
        <p className="lu-eyebrow">Commerce operations platform</p>
        <h1 id="landing-title">
          Spend less time fixing the same order problems
        </h1>
        <p className="landing-lead">
          Luma works across the systems your business already uses. It
          investigates problems, makes the changes you’ve agreed on, and checks
          that the fix worked, so your team can keep its attention for the
          decisions that need it.
        </p>
        <div className="landing-actions">
          <a className="landing-button" href="/sign-in">
            Sign in
          </a>
          <a
            className="landing-button"
            data-variant="secondary"
            href="/sign-up"
          >
            Create account
          </a>
        </div>
      </section>
      <section className="landing-panel" aria-label="How Luma works">
        <ol className="landing-loop">
          {loop.map(({ step, detail, state }, index) => (
            <li key={step}>
              <span className="landing-loop-index">
                {String(index + 1).padStart(2, '0')}
              </span>
              <StateDot state={state} />
              <strong>{step}</strong>
              <span>{detail}</span>
            </li>
          ))}
        </ol>
        <ResolutionStory />
      </section>
      <footer className="landing-footer">
        <span>Luma, by Auren Labs</span>
        <span>We’re building Luma with a small group of design partners.</span>
      </footer>
    </main>
  );
}
