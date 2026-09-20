/** Renders the public landing page with account creation and sign-in links. */
export function Home() {
  return (
    <main>
      <p className="wordmark">
        Luma<span aria-hidden="true">.</span>
      </p>
      <div className="intro">
        <p className="eyebrow">A clearer way to operate</p>
        <h1>
          Make room for
          <br />
          what matters.
        </h1>
        <p className="description">
          A clearer view of your commerce operations.
        </p>
        <div className="landing-actions">
          <a className="action-link" href="/sign-up">
            Create account ↗
          </a>
          <a href="/sign-in">Sign in</a>
        </div>
      </div>
      <footer>Built for the work ahead.</footer>
    </main>
  );
}
