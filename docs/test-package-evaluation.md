# Test package evaluation

Evaluated on 2026-09-29 against performance commit `5b33ef1`, using Node 24.21.0
on the same 14-core, 48 GiB machine as the [initial measurements](test-performance.md).
Experiments ran in a detached worktree. Application dependencies were not changed.

## Decisions

| Package                   | Decision                                          | Evidence                                                                                                                            |
| ------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Vitest 5.0.2              | Keep Vitest 4.1.11 for now.                       | No default-config speedup in the two measured packages; stable Storybook's addon excludes Vitest 5.                                 |
| `@playwright/test` 1.63.0 | Adopt for diagnostics, not a measured speed gain. | A prototype with worker-scoped Chromium performed essentially the same as the existing identity journeys.                           |
| Hyperfine 1.20.0          | Use as an optional developer benchmark tool.      | Repeated measurements expose variability, export JSON, and fail when a measured command fails. No application dependency is needed. |

## Vitest 5

Hyperfine ran one warmup followed by five measured runs per command. Values below
are whole-command means and sample standard deviations, including pnpm and runner
startup. Both versions ran the same tests and configuration in the same checkout,
with no other benchmark running concurrently.

| Suite                         |   Vitest 4.1.11 |    Vitest 5.0.2 | Result                                     |
| ----------------------------- | --------------: | --------------: | ------------------------------------------ |
| Platform: 179 tests, 7 files  | 0.610 ± 0.011 s | 0.643 ± 0.030 s | No improvement; observed mean 5.5% slower. |
| Workflows: 98 tests, 18 files | 1.500 ± 0.038 s | 1.503 ± 0.030 s | Essentially unchanged.                     |

All measured commands exited successfully. The non-UI Vitest dependencies were
upgraded only in the experiment; the UI retained Vitest 4. This is a comparison of
these 277 tests, not validation of a workspace-wide Vitest 5 migration.

Enabling Vitest 5's `--fsModuleCache` reduced the workflows mean to
**1.421 ± 0.031 s**: about 5.5%, or 82 ms, below its uncached configuration.
This is a warm-cache result; it does not establish a cold CI benefit.

`vitest doctor` also ran the platform suite under alternative settings. Its
minimum-of-three measurements found threads 5% faster, disabled isolation 1%
faster, filesystem caching 8% faster, and six workers 1% faster. It recommended
keeping the current configuration because no candidate exceeded its 10% threshold.
Those minimum timings are separate from the Hyperfine means above.

Registry checks found:

- Latest stable Vitest: **5.0.2**, compatible with the project's Node 24 runtime.
- Latest stable `@storybook/addon-vitest`: **10.6.0**, with Vitest peers
  `^3.0.0 || ^4.0.0` and browser-playwright peer `^4.0.0`.
- `@storybook/addon-vitest@next`: **11.0.0-alpha.1**, whose peers include Vitest 5
  but also require Storybook 11 alpha.

The [Vitest 5 release](https://vitest.dev/blog/vitest-5) adds useful diagnostics
and caching features, but these local results do not justify an upgrade for speed.
Reconsider when stable Storybook supports it, and then validate Storybook, Temporal,
database suites and E2E before adoption. Disabling test isolation is not needed for
the measured E2E improvements already committed.

## Playwright Test

The prototype ported all four tests from `apps/api/e2e/identity.browser.mjs` to
`@playwright/test`, preserving their assertions and journeys. It replaced Vitest's
test registration, polling helper and cleanup context with a Playwright adapter.
Chromium was worker-scoped, while every test still received a fresh browser
context, database, API and Vite server. Both runners used one worker and no retries.

One disposable PostgreSQL server served both benchmark variants, with the same
fast-write settings as the normal test runner. Each variant received one warmup
and three measured runs:

| Variant                                     | Mean ± standard deviation |           Range |
| ------------------------------------------- | ------------------------: | --------------: |
| Vitest 4, Chromium launched per test        |          25.207 ± 0.371 s | 24.822–25.562 s |
| Playwright Test, Chromium reused per worker |          25.360 ± 0.167 s | 25.171–25.486 s |

Every run passed all four tests. The 0.153 s difference is small compared with the
observed variation; there is no useful performance gain from this prototype.
This does not measure a migration of all browser files or reuse of the Vite/API
servers. Those fixtures still start for every test in both variants.

[Worker-scoped fixtures](https://playwright.dev/docs/test-fixtures#worker-scoped-fixtures)
remain useful for lifecycle management. A future runner migration could be
justified by reporting or debugging needs, but browser reuse alone does not
justify it for speed. Profile server startup and navigation before undertaking a
larger fixture redesign.

## Hyperfine

The evaluation used the official macOS ARM64 binary from the
[Hyperfine 1.20.0 release](https://github.com/sharkdp/hyperfine/releases/tag/v1.20.0),
installed in a temporary tools directory. All exported exit codes were zero.
Keep this as a developer CLI rather than adding it to `package.json` or every CI job.

For a focused repeatable measurement, run from the repository root with Node 24:

```sh
hyperfine --warmup 1 --runs 5 --export-json /tmp/luma-workflows-benchmark.json \
  'pnpm --filter @luma/workflows exec vitest run'
```

For an A/B comparison, measure the same command before and after the change with
the same test selection, workers, Node version and cache conditions. Keep the raw
JSON and pass/fail output. Warm measurements do not replace separate cold-start
measurements or actual CI validation.

## Implementation follow-up

Playwright Test now runs all 30 browser journeys. It reuses Chromium per worker,
keeps contexts and databases isolated per test, and retains failure traces and
screenshots. The choice is for diagnostics and fixture ownership; the prototype
timings above remain the performance evidence. Vitest 4 continues to run unit,
backend and Storybook tests.

Hyperfine 1.20.0 is available through `pnpm setup:benchmarks` and `pnpm benchmark`.
It is an optional local binary, verified against pinned archive checksums. A
manual CI workflow records repeated measurements without adding a PR gate.
See [benchmarking](benchmarking.md) for commands and interpretation.
