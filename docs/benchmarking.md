# Performance measurement

Measure before claiming a performance change, and keep raw results in the pull request or
Linear issue rather than in these guides. Guides record the resulting limits and budgets.

## Performance budgets

Performance scenarios in the backend and browser suites write measurements, budgets and
violations to `.luma/performance`; CI uploads them per shard and summarizes budgets in the
job summary. Reports are written before a budget failure is raised. Current ceilings:

- Order page payloads: 128 KiB for 50 items.
- Metric SSE frames: 4 KiB; the five measured subscribers: 128 KiB in total.
- Cross-domain operational summary: 12 SELECT/WITH statements for its six readers.
- Live metrics: p95 commit-to-visible below one second.
- Shopify contention: p95 live reads below two seconds, an approved action below five
  seconds, and import progress averaging below ten seconds per imported record. The
  synthetic workload offers one live read per second alongside two sync processes and
  simulated provider throttling. These ceilings cover the whole foreground request.

These are regression ceilings, not production latency guarantees. Review the scenario and
its report before changing a budget; never raise one just to silence a failure.

Some feature tests take an opt-in size variable for larger synthetic datasets, such as
`LUMA_ORDER_BENCHMARK` or `LUMA_RETURN_BENCHMARK`; the feature guides name them.

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
