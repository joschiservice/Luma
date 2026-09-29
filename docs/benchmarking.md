# Test benchmarks

Use Hyperfine for repeated whole-command measurements. Install the pinned CLI
once with `pnpm setup:benchmarks` (macOS or Linux, arm64 or x64). Setup verifies
the official release archive's SHA-256 before installing into `.luma/tools`.
It does not add an application dependency.

```sh
pnpm setup:benchmarks
pnpm benchmark --suite browser --workers 1 --label serial
pnpm benchmark --suite browser --workers 6 --label parallel
pnpm benchmark --suite e2e --workers 4 --runs 5 --warmup 1 --label backend
pnpm benchmark --suite workflows --runs 2 --warmup 0 --label smoke
```

Suites are `main`, `e2e`, `browser`, `full`, and `workflows`. The first four run
the corresponding root test command, including its build and database setup.
`workflows` builds its prerequisites once before timing that package's Vitest
suite directly. `--workers` is supported
for `browser` and `e2e`; omit it to measure the configured default.
The default is five measured runs after one warmup. Add `--show-output` for test
logs. A failing command stops the benchmark with a nonzero exit code.

Each invocation creates `.luma/benchmarks/<timestamp>-<label>/` containing:

- `results.json`: Hyperfine samples, summary statistics and command exit codes
  for a successful benchmark.
- `metadata.json`: command, run counts, worker override, Git revision and dirty
  state, tool versions, CPU, available parallelism, memory and completion status.

Run comparisons sequentially on an idle machine. Keep test selection, Node,
hardware, database configuration and cache conditions the same. Normal warmups
populate build caches; use separate clean checkouts for cold-build experiments.
The runner does not clear caches between samples. Compare means and variability,
and check every run passed before claiming an improvement.

For CI measurements, dispatch **Test benchmarks** in GitHub Actions, selecting
the suite, run count and optional worker count. The job uploads results and any
Playwright diagnostics even on failure. Hosted-runner variance makes small
differences unreliable; this workflow is not a required PR gate.

## Browser diagnostics

Playwright Test writes its latest HTML report, JSON results and failure artifacts
under `.luma/playwright/`. Open the HTML report with `pnpm test:browser:report`.
Failures retain screenshots and traces with actions, DOM snapshots and network
activity. Each CI browser shard uploads its own report. Local runs overwrite the
previous browser report, including successive Hyperfine samples; benchmark JSON
and metadata remain in their timestamped directories.

Browser files run in parallel; tests within each file run sequentially. Workers
reuse Chromium, while each test creates fresh contexts and isolated databases.
The disposable PostgreSQL container allows 300 connections for concurrent service
pools. A supplied `TEST_DATABASE_URL` uses that server's existing limits; provision
enough connections for the worker count or lower `--workers`.
Retries are disabled. Use `--workers=1` to investigate ordering or resource
contention, `--grep` to select a journey, and `--shard=1/4` to reproduce a CI shard.
