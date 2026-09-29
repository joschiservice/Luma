# Test performance

## Measurement context

Measured on 2026-09-29. The local machine has 14 CPU cores and 48 GiB RAM;
Docker has 14 CPUs and about 29 GiB RAM. Use Node 24.21.0 from `.nvmrc` when
comparing runs. The default shell was using Node 26, so local measurements below
explicitly use Node 24.

The reference [successful CI run](https://github.com/joschiservice/Luma/actions/runs/36521574624)
is commit `5c9ab8f`. This private repository uses `ubuntu-latest`, for which
[GitHub documents 2 CPUs and 8 GB RAM](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Local and CI times are not directly comparable: CI includes dependency installation,
browser installation, runtime setup and colder build caches.

| CI job                            | Whole job |    Test runner or Turbo test phase |
| --------------------------------- | --------: | ---------------------------------: |
| Main tests, including Storybook   |     466 s |                              377 s |
| Simulator integration and browser |     378 s | 179 s for transitive package tests |
| Backend E2E                       |     509 s |                              324 s |
| Browser E2E shard 1/2             |     477 s |                              300 s |
| Browser E2E shard 2/2             |     640 s |                              430 s |
| Static checks and builds          |     307 s |                                  — |

These are observations from one successful run, not medians. The newer run at
`f9cd509` has existing Storybook and browser failures; it is not a successful timing
baseline. CI improvements need confirmation after the changed workflow runs.

## Local comparison

At `f9cd509`, using Node 24.21.0, warm build caches and the same disposable
PostgreSQL settings, the sequential baseline passed all 55 backend tests and all
30 browser tests. Four-worker runs passed the same tests without skips or retries:

| Suite                    | Sequential | Four workers | Reduction |
| ------------------------ | ---------: | -----------: | --------: |
| Backend E2E, 18 files    |   183.25 s |      99.67 s |       46% |
| Browser E2E, 25 files    |   313.61 s |      91.80 s |       71% |
| Combined E2E runner time |   496.86 s |     191.47 s |       61% |

These are single-run Vitest durations, excluding command startup, builds and
container lifecycle. The parallel commands took 108.21 s and 95.61 s end to end.
An additional six-worker browser run passed all 30 tests in 72.45 s (77.59 s for
the whole command), so the browser cap is six. With four backend workers and six
browser workers, combined E2E runner time is 172.12 s: 65% less time, or about
2.9 times faster than the sequential baseline.
The package-test Turbo phase in the baseline took 18.54 s, making E2E the larger
local opportunity. Formatting, lint, type checks and builds also passed in the
baseline full check.

## Changes

- E2E file workers use half the available CPUs, capped at four for backend tests
  and six for browser tests. Two-CPU CI shards keep one. Process isolation,
  sequential tests within files, database isolation, migration locks and
  assertions remain in place.
  Override with `--maxWorkers=1` for a sequential comparison.
- CI uses two backend shards and four browser shards. Vitest shards by file, so
  large files can still dominate. More shards also repeat job setup and builds;
  compare total runner minutes as well as elapsed time.
- Storybook has its own CI job. Main tests exclude only `@luma/ui`; ordinary
  `pnpm test` still includes it. Turbo concurrency follows available CPUs in CI
  instead of allowing ten package tasks to compete on two CPUs.
- Simulator tests select the simulator packages without the transitive `...`
  test filter. The previous filter also ran Storybook, Temporal and application
  suites already covered by the main job. Dependency builds still run.

## Expensive tests

File durations from the reference CI run include fixture setup and cleanup:

| File                                                        | Duration | Follow-up                                                                            |
| ----------------------------------------------------------- | -------: | ------------------------------------------------------------------------------------ |
| `apps/api/e2e/pilot.e2e.mjs`                                |    134 s | Separate the recovery scenario from the other pilot scenarios to improve scheduling. |
| `apps/api/e2e/identity.browser.mjs`                         |    101 s | Four journeys each start their own database, API, Vite server and Chromium.          |
| `apps/api/e2e/cases.browser.mjs`                            |     67 s | Long journey, including a deliberate 6.5 s slow-response check.                      |
| `packages/workflow-temporal/src/exception-workflow.test.ts` |     52 s | Real Temporal startup, worker lifecycle and replay checks.                           |
| `apps/api/e2e/connections.browser.mjs`                      |     49 s | Three browser journeys with repeated fixture startup.                                |

The pilot recovery test kills a worker after a provider write. Its workflow has a
one-minute activity timeout, so more CPUs cannot remove that wait. Keep this real
crash-recovery coverage. A separate file would let the remaining pilot tests run
alongside it. Do not shorten the production timeout just to speed up tests.
In the local parallel run, that single test took 64.36 s; the entire pilot file
took 95.82 s in the sequential baseline.

Database migration helpers hold a cluster-wide advisory lock through migration.
Increasing workers indefinitely therefore cannot scale database setup linearly.
Template databases are a possible later experiment, but must preserve migration,
role and tenant-isolation coverage; migration tests still need fresh databases.

## Packages and further experiments

1. **Vitest 5:** its [release notes](https://vitest.dev/blog/vitest-5) describe
   `vitest doctor`, persistent module caching and Browser Mode improvements.
   Benchmark it in a separate dependency upgrade. Installed
   `@storybook/addon-vitest@10.6.0` declares Vitest 3/4 peers, so coordinate the
   Storybook addon and Vitest browser packages first. Upstream benchmark gains
   are not a prediction for this repository.
2. **`@playwright/test`:** the E2E suite currently uses Playwright's browser library
   inside Vitest. The dedicated runner offers [worker-scoped fixtures](https://playwright.dev/docs/test-fixtures)
   and [parallel execution and sharding](https://playwright.dev/docs/test-parallel).
   Browser reuse and fixture lifecycle would be the reason to migrate. Preserve
   fresh contexts and isolated databases. Treat this as a separate test-harness
   change, not a drop-in speed switch.
3. **Hyperfine:** use the [benchmark CLI](https://github.com/sharkdp/hyperfine)
   for repeated whole-command comparisons and variability. It need not become
   an application dependency. Compare warm and cold builds separately.

Before adding packages, use the existing
[Vitest import profiler](https://v4.vitest.dev/guide/profiling-test-performance)
to distinguish import overhead from fixture and test time:

```sh
pnpm test:e2e --maxWorkers=1 --reporter=default --reporter=json --outputFile.json=/tmp/luma-e2e-serial.json
pnpm test:e2e --maxWorkers=4 --reporter=default --reporter=json --outputFile.json=/tmp/luma-e2e-parallel.json
pnpm test:browser --maxWorkers=1
pnpm test:browser --maxWorkers=4
pnpm test:browser --maxWorkers=6
pnpm --filter @luma/workflows exec vitest run --experimental.importDurations.print
```

Run comparisons sequentially on an otherwise idle machine. Preserve the same
Node version, database settings, test selection and cache conditions. Check both
pass/fail results and timings; retries or skipped tests can hide regressions.
