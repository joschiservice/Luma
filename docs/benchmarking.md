# Performance measurement

Measure before claiming a performance change, and keep raw results in the pull request or
Linear issue rather than in these guides. Guides record the resulting limits and budgets.

## Performance budgets

Budgets split by the kind of check:

- Deterministic budgets, such as statement counts, payload and frame sizes and request
  counts, are ordinary journey assertions. They hold on any machine, so they run wherever
  the journey runs.
- Timing budgets depend on machine load and need repeated samples, so they live in the
  performance suite. A scenario named `<name>.performance.e2e.mjs` or
  `<name>.performance.browser.mjs` in `apps/api/e2e` measures a journey's workload; the
  journey keeps the behavior checks with only the iterations they need.

`pnpm test:performance` builds, then runs the backend scenarios and then the browser
scenarios, one at a time. Name filters select scenarios, as in
`pnpm test:performance metric-live`. The journey suites and `pnpm test:affected` never run
them; `pnpm test:full` runs them last, alone, and CI runs them in the playbook evaluation job.

Scenarios write measurements, budgets and violations to `.luma/performance` before a budget
failure is raised; CI summarizes the budgets in the job summary and uploads the reports.

Journey ceilings:

- Order page payloads: 128 KiB for 50 items.
- Metric SSE frames: 4 KiB.
- Cross-domain operational summary: 12 SELECT/WITH statements for its six readers.

Performance suite ceilings:

- Live metrics: p95 commit-to-visible within three seconds, since dashboards read again at
  most every two seconds. The workload is 20 sequential writes with two API processes and
  six subscribers; the five measured subscribers receive at most 128 KiB in total.
- Large order journeys: a detail read of a 1,000-line order within two seconds and its
  milestone query within 100 ms.
- Shopify contention: p95 live reads below two seconds, an approved action below five
  seconds, and import progress averaging below ten seconds per imported record. The
  synthetic workload offers one live read per second alongside two sync processes and
  simulated provider throttling. These ceilings cover the whole foreground request.
- Request pool: ten concurrent Needs-you reads and ten order-list reads, five rounds, with
  100 purchasing plans and a 5 ms delay on each direction of the database connection. No
  request may fail, and each read's p95 stays within two seconds. The delay makes connection
  hold time, not local query speed, decide whether the pool keeps up.

Operational-metric latency and metric listener recovery are recorded without a ceiling.
These are regression ceilings, not production latency guarantees. Review the scenario and
its report before changing a budget; never raise one just to silence a failure.

Some scenarios take an opt-in size variable for larger synthetic datasets, such as
`LUMA_RETURN_BENCHMARK=<return count> pnpm test:performance returns`, and skip without it.
Package integration tests take others, such as `LUMA_ORDER_BENCHMARK`. The feature guides
name them. These size benchmarks write their timings and plans only when `LUMA_CAPTURE`
names a directory (see [tests](development.md#tests)); without it they still run and assert,
but keep no measurements.

## Whole-command benchmarks

Hyperfine measures repeated whole-command runs. Install the pinned binary once with
`pnpm setup:benchmarks`; it verifies the release checksum and installs into `.luma/tools`
without adding a dependency.

```sh
pnpm benchmark --suite browser --workers 1 --label serial
pnpm benchmark --suite browser --workers 6 --label parallel
pnpm benchmark --suite e2e --workers 4 --runs 5 --warmup 1 --label backend
```

Suites are `main`, `e2e`, `browser`, `full` and `workflows`. The defaults are one warmup and
five measured runs; `--workers` applies to `browser` and `e2e`, and `--show-output` prints
test logs. A failing run stops the benchmark. Each invocation writes `results.json` and
`metadata.json` (revision, dirty state, tool versions and hardware) to
`.luma/benchmarks/<timestamp>-<label>/`.

For CI numbers, dispatch the **Test benchmarks** workflow. Hosted-runner variance makes
small differences unreliable; it is not a PR gate.

## Comparing fairly

- Run comparisons one after another on an idle machine, with the same Node version, test
  selection, worker count, database settings and cache state.
- Warm runs populate build caches. Measure cold builds separately in clean checkouts.
- Compare means and variability, and confirm every run passed; retries or skips hide
  regressions.
- To separate import cost from fixture and test time, use Vitest's
  `--experimental.importDurations.print`.
- For database work, capture `EXPLAIN (ANALYZE, BUFFERS)` as the restricted runtime role
  with RLS enabled. Plans as the administrator can differ.

## Test tooling decisions

- Unit and backend tests stay on Vitest 4: Vitest 5 showed no speedup here, and the stable
  Storybook Vitest addon does not support it yet. Revisit when it does, validating
  Storybook, Temporal, database and E2E suites.
- Browser journeys use Playwright Test for fixture ownership, traces and reports. Reusing
  Chromium per worker did not measurably speed them up; server startup per test dominates.
- E2E parallelism, not package changes, produced the large local gains. The worker caps are
  described in [local development](development.md#tests).
