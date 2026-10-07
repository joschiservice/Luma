# @luma/simulator-web

The simulator control panel: a React single-page app built on `@luma/ui`. The simulator host serves its build output beside the control API.

The panel creates and drives runs, edits chaos profiles, injects and recovers incidents, compares ground truth with Luma's cases, and browses provider records and the activity journal. It reads and writes only through the simulator control API, using `@luma/simulator-contract`. Scheduling, persistence and provider behavior belong to the host and simulator packages.

Every request sends a bearer token. The panel uses the local development token by default, accepts `?token=` once (and removes it from the address), and keeps the token for the browser tab only.

The `dev` script runs Vite with `/api` proxied to `LUMA_SIMULATOR_ORIGIN` (default `http://127.0.0.1:5890`).

## Further reading

- [Simulator](../../docs/simulator.md)
- [Shared frontend components](../../docs/frontend-ui.md)
