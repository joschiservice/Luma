# @luma/simulator-web

The simulator control panel: a React single-page app built on `@luma/ui`. The simulator host serves its build output beside the control API.

## Responsibilities

The panel creates and drives runs, edits chaos profiles, injects and recovers incidents, compares ground truth with Luma's cases, and browses provider records and the activity journal. It reads and writes only through the simulator control API, using request schemas and response types from `@luma/simulator-contract`. Scheduling, persistence and provider behavior belong to the host and simulator packages.

Every request sends a bearer token. The panel uses the local development token by default, accepts `?token=` once (and removes it from the address), and keeps changes for the browser tab only.

## Entry points

- [src/main.tsx](src/main.tsx) mounts the app; [src/features/runs/workspace.tsx](src/features/runs/workspace.tsx) owns run selection and page states.
- [src/api.ts](src/api.ts) is the HTTP client; [src/queries.ts](src/queries.ts) holds the TanStack Query hooks and polling intervals.
- `src/features/<view>` contains one folder per tab; `src/lib` holds pure formatting, metric and chaos-editing helpers with unit tests.

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm --filter @luma/simulator-web build   # writes dist/index.html and dist/assets for the host
pnpm --filter @luma/simulator-web dev     # Vite with /api proxied to LUMA_SIMULATOR_ORIGIN (default http://127.0.0.1:5890)
pnpm --filter @luma/simulator-web test
```

## Further reading

- [Engineering guide](../../docs/simulator.md)
- [Shared frontend components](../../docs/frontend-ui.md)
