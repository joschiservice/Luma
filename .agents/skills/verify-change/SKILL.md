---
name: verify-change
description: Check that a Luma change is complete across contracts, entry points, runtimes, providers, lifecycle, authority and presentation, then run the right tests and report the results. Use before calling a feature done, before opening or updating a pull request, and when deciding which tests a change needs.
---

# Verifying a change

## 1. Follow the whole behavior

Go through each path the change affects and fix what's missing before running tests:

- **Contracts:** the shared API schema in `@luma/api-contract`, server behavior and every
  consuming client change together.
- **Entry points:** relevant pages, detail views, Home modules, search, the command menu,
  shortcuts and contextual help.
- **Runtime paths:** API, worker, pilot and simulator share services, but each has its own
  composition in `packages/application-runtime/src/composition`. A fix in one path may be
  missing in another.
- **Providers:** decide how a capability change affects each installed adapter and its
  simulator.
- **Lifecycle:** retries, cancellation or reversal where supported, worker restart, recurrence
  and uncertain outcomes. Retries must not duplicate external effects; closure needs fresh,
  independent verification.
- **Authority:** tenant boundaries, role restrictions and approval changes where they affect
  the behavior.
- **Presentation:** light and dark themes, narrow layouts, keyboard use, both interface
  languages and meaningful status labels for loading, stale, unavailable, failed and empty
  states.
- **Documentation:** update or remove guidance the change made inaccurate, in `docs/`, in
  directory `AGENTS.md` files, in these skills and in the product guides in
  `apps/web/content/docs`.

## 2. Test, smallest first

Test observable behavior and important failure cases. Reuse the identity, database and
simulator fixtures; wait for observable state with bounded assertions instead of sleeps.

| Scope                      | Command                                                         |
| -------------------------- | --------------------------------------------------------------- |
| One rule or service        | `pnpm --filter @luma/resolution test inventory-monitor.test.ts` |
| One database integration   | `pnpm run test --filter=<package> -- <file>`                    |
| One backend journey        | `pnpm test:e2e <file.e2e.mjs>`                                  |
| One browser journey        | `pnpm test:browser <file.browser.mjs>`                          |
| Shared UI components       | `pnpm test:ui`                                                  |
| A feature area             | `pnpm verify:feature <area>`                                    |
| Documentation-only changes | `pnpm format:check` and `pnpm test:architecture`                |
| Ready for review           | `pnpm check`, then `pnpm test:affected`                         |
| Every CI gate              | `pnpm test:full`                                                |

Substitute the owning package and file in the focused commands. `pnpm --filter … test`
runs Vitest without a database, so database integration tests skip; the `pnpm run test`
form goes through the runner that provisions one. For shared UI, also inspect the relevant
stories and test the integrated journey when routing, authentication or live data changes. Run `pnpm check` and
`pnpm test:affected` once the change is ready, not after every edit: a change to a shared path
runs every journey, and journeys from all worktrees on the machine wait for one shared slot.
`TURBO_SCM_BASE=HEAD` limits `test:affected` to uncommitted changes. When it reports a path
that forces every journey, map that path in `apps/api/e2e/journey-areas.mjs` if it belongs to
specific journeys.

Keep test selection accurate:

- Map a new journey file in `apps/api/e2e/journey-areas.mjs`.
- Add new scenario tests or packages to the selections in `tooling/dev/verify-feature.mjs` and
  `tooling/dev/test-plan.mjs`.
- Package test results are cached: declare files a test reads from outside its package in
  that package's `turbo.json` test `inputs`.

Browser failures keep traces and screenshots in `.luma/playwright`; open the report with
`pnpm test:browser:report`. See [feature validation](../../../docs/development.md#feature-validation)
for flags that reproduce flaky failures.

## 3. Clean up and report

- Run `pnpm lint:fix` and `pnpm format` and review the resulting diff.
- Stop the containers and processes you started (development servers, workers, test
  services) with the worktree's shutdown commands, such as `pnpm dev:down`, and check that
  they stopped. Leave pre-existing services and persistent data alone.
- Report what you checked, the result and any behavior you couldn't verify. A skipped suite is
  not a passing one; `pnpm test:local` skips database integration tests, so say so when you
  rely on it.
