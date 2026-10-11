import { m } from '@luma/i18n/messages';
import { LumaLockup } from '@luma/ui/components/primitives/brand';
import { StateDot } from '@luma/ui/components/primitives/state';

import { ResolutionStory } from './features/account/story';

const loop = [
  {
    id: 'detect',
    step: m.identity_landing_detect,
    detail: m.identity_landing_detect_detail,
    state: 'error',
  },
  {
    id: 'diagnose',
    step: m.identity_landing_diagnose,
    detail: m.identity_landing_diagnose_detail,
    state: 'attention',
  },
  {
    id: 'decide',
    step: m.identity_landing_decide,
    detail: m.identity_landing_decide_detail,
    state: 'approval',
  },
  {
    id: 'act',
    step: m.identity_landing_act,
    detail: m.identity_landing_act_detail,
    state: 'running',
  },
  {
    id: 'verify',
    step: m.identity_landing_verify,
    detail: m.identity_landing_verify_detail,
    state: 'verified',
  },
] as const;

/** Renders the public entry page with sign-in and account creation links. */
export function Home() {
  return (
    <main className="landing">
      <header className="landing-bar">
        <a
          className="entry-brand"
          href="/"
          aria-label={m.identity_brand_home_label()}
        >
          <LumaLockup byAuren />
        </a>
        <a className="landing-link" href="/sign-in">
          {m.identity_auth_signin_submit()}
        </a>
      </header>
      <section className="landing-hero" aria-labelledby="landing-title">
        <p className="lu-eyebrow">{m.identity_landing_eyebrow()}</p>
        <h1 id="landing-title">{m.identity_landing_title()}</h1>
        <p className="landing-lead">{m.identity_landing_lead()}</p>
        <div className="landing-actions">
          <a className="landing-button" href="/sign-in">
            {m.identity_auth_signin_submit()}
          </a>
          <a
            className="landing-button"
            data-variant="secondary"
            href="/sign-up"
          >
            {m.identity_auth_signup_submit()}
          </a>
        </div>
      </section>
      <section
        className="landing-panel"
        aria-label={m.identity_landing_loop_label()}
      >
        <ol className="landing-loop">
          {loop.map(({ id, step, detail, state }, index) => (
            <li key={id}>
              <span className="landing-loop-index">
                {String(index + 1).padStart(2, '0')}
              </span>
              <StateDot state={state} />
              <strong>{step()}</strong>
              <span>{detail()}</span>
            </li>
          ))}
        </ol>
        <ResolutionStory />
      </section>
      <footer className="landing-footer">
        <span>{m.identity_landing_byline()}</span>
        <span>{m.identity_landing_partners()}</span>
      </footer>
    </main>
  );
}
