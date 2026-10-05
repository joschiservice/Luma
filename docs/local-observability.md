# Local performance diagnostics

Run the application with a local Grafana stack:

```sh
mise exec -- pnpm dev:observe
```

This starts PostgreSQL, Temporal, Grafana, the API, the worker, and the web app. The terminal prints the Grafana address. Sign in with `admin` / `admin`, then open **Dashboards → Luma → Luma local performance**. Each checkout gets its own Docker project, dynamically allocated loopback ports, and telemetry volume.

No vendor account is needed. Local mode overrides hosted telemetry credentials from `.env`, uses 100% tracing, and sends signals to local Docker services. Grafana, Tempo, Loki, and Pyroscope usage reporting is disabled. The application can still call its configured commerce/model providers; local observability does not change business integrations.

Use Node 24 through `mise`. The native Pyroscope profiler ships Node ABI-specific binaries. The ordinary `pnpm dev` command keeps its existing telemetry behavior; `dev:observe` opts into local tracing and profiling.

## Pilot and simulator

`pnpm pilot` and `pnpm pilot:worker` automatically start the Docker observability stack and export local telemetry. Run them in separate terminals. `pnpm simulator` starts the same stack, the pilot API and worker, the simulator service, and the web app together. Stop `dev:observe` before switching modes because they share the API and web ports.

Select `luma-pilot-api`, `luma-pilot-worker`, or `luma-simulator` in the dashboard. Pilot requests include PostgreSQL queries, pool waits, algorithm timings, and propagated Temporal workflow/activity spans. Simulator provider calls continue the caller's trace through HTTP into the simulator's PostgreSQL queries, including clock ticks and webhook delivery. CPU, wall-time, and heap profiles are collected for all three processes.

The standalone `simulator:service` command remains a minimal simulator service without the application or diagnostics stack; use `pnpm simulator` for the full instrumented environment.

With the relevant mode running, verify it from another terminal:

```sh
mise exec -- pnpm observe:verify pilot
mise exec -- pnpm observe:verify simulator
```

The simulator check also verifies simulator PostgreSQL traces and profiles. Seeds and existing simulator state are preserved; telemetry does not reset scenarios or resume paused runs.

## Verify the installation

With `dev:observe` running, use another terminal:

```sh
mise exec -- pnpm observe:verify
```

The check generates readiness requests, then verifies their database child spans and pool waits in Tempo, duration metrics in Prometheus, correlated completion logs in Loki, and profiles for both API and worker in Pyroscope. It also checks that a private query/header canary does not enter the exported trace. It prints a trace ID and dashboard URL.

## Find the bottleneck

| Question                                         | Where to look                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Which operations are slow?                       | Dashboard: p50, p95, p99, throughput, failures, and database time                                               |
| Which query or outgoing call slowed one request? | Explore → Tempo; paste the response's `x-trace-id`                                                              |
| Is the connection pool saturated?                | Pool acquisition spans and pool pending-request metrics                                                         |
| Which functions consume CPU?                     | Profiles Drilldown or Explore → Pyroscope; select `luma-api` or `luma-worker`, then the `wall:cpu` profile type |
| Which functions allocate memory?                 | Pyroscope memory profiles; compare with the dashboard's heap and resident-memory charts                         |
| Is JavaScript blocking the event loop?           | Event-loop delay and CPU charts                                                                                 |
| Is an activity waiting or retrying?              | Activity queue-delay and retry charts; inspect the Temporal trace                                               |
| What happened in a request?                      | The trace's logs link, or Explore → Loki filtered by `trace_id`                                                 |

The dashboard refreshes every five seconds. Generate traffic before judging it: percentile/rate charts need multiple exports, and activity charts remain empty until an activity runs. Profiles upload about every ten seconds. Heap profiles are sampled allocations; they are not full heap snapshots.

The services are named `luma-api` and `luma-worker`. Use the same service and time window when comparing a trace with a profile. Node profiles currently provide process-level evidence, not exact per-span CPU attribution. Span durations include waiting; nested or concurrent spans must not be summed to infer total request duration.

Useful Tempo queries:

```traceql
{ resource.service.name = "luma-api" && duration > 100ms }
{ name = "db.SELECT" && duration > 20ms }
{ resource.service.name = "luma-worker" }
{ span.luma.db.query_id = "YOUR_QUERY_ID" }
```

## Database investigation

All `pg` queries are traced, including identity/ORM queries and transaction setup. `db.pool.acquire` includes pool waiting and, when a new connection is required, connection establishment; its nested `db.connect` span shows connection establishment. `db.transaction` wraps the complete tenant-scoped transaction. Query spans include operation, row count, and a deterministic `luma.db.query_id`. They exclude SQL text and parameter values.

Find the matching static SQL source with:

```sh
mise exec -- pnpm observe:queries 0123456789abcdef
```

The command hashes TypeScript string literals using the same algorithm as tracing and prints matching source locations. Dynamically assembled and ORM-generated SQL may have no static match.

Inspect PostgreSQL's top query patterns locally:

```sh
mise exec -- pnpm observe:queries
```

This reads `pg_stat_statements` using the worktree's local admin connection. It prints normalized SQL and execution/I/O statistics for the API and worker roles to your terminal, not to telemetry. Admin/migration statements are excluded. Statistics accumulate across runs. The local PostgreSQL container preloads the extension, and dev provisioning enables it in the Luma database without broadening API or worker privileges.

Use `EXPLAIN (ANALYZE, BUFFERS)` on representative queries to investigate plans. `ANALYZE` executes the statement; use disposable data or a transaction you can roll back for writes. Client query spans include network/driver overhead, while PostgreSQL statistics describe server execution. These measurements answer different questions.

## Instrument another algorithm

Application services can wrap a synchronous algorithm or asynchronous operation with `measureSync` or `measure` from the platform interface. Add the operation's fixed name to `PerformanceOperation`. The adapter is installed at process startup in local mode; without it, work runs directly.

```ts
const result = measureSync('diagnosis.evaluate', () => diagnose(snapshot, now));
```

Do not place customer data in operation names. CPU profiles capture functions without requiring a span around every function. The current named boundaries cover detection, diagnosis, policy evaluation, and tenant transactions. Temporal's tracing plugin instruments workflow/client/activity boundaries and propagates their context; custom queue metrics measure current-attempt scheduling to activity entry, including delivery overhead.

## Benchmark reliably

Use a repeatable workload and representative database sizes. Warm up the process first. Compare the same inputs before and after a change. For repeatable measurements, run the compiled API/worker rather than the watch process:

```sh
mise exec -- pnpm exec turbo run build --filter=@luma/api...
mise exec -- node --env-file-if-exists=apps/api/.env --env-file=.luma/env apps/api/dist/composition/bootstrap.js
# In another terminal, if workflows are needed:
mise exec -- node --env-file-if-exists=apps/worker/.env --env-file=.luma/env apps/worker/dist/bootstrap.js
```

Stop the watch processes first to avoid port conflicts; keep the Docker services running. `.luma/env` contains the generated local service settings from `dev:observe`. Run the same workload with `LUMA_LOCAL_OTLP_ENDPOINT=` and `LUMA_LOCAL_PROFILES_ENDPOINT=` to measure instrumentation overhead. Keep hosted credentials unset for that baseline.

## Lifecycle and configuration

- Ctrl+C stops the development processes. Docker services remain available for investigation.
- `pnpm dev:down` stops this checkout's services and preserves their volumes.
- Telemetry persists in the worktree's `observability` Docker volume. Remove only that volume after stopping the stack if you want an empty history; the PostgreSQL volume is independent.
- `LUMA_LOCAL_OTLP_ENDPOINT` selects the local OTLP HTTP receiver.
- `LUMA_LOCAL_PROFILES_ENDPOINT` enables Pyroscope profiling. Omit it for tracing/metrics/logs without the native profiler.
- Both endpoints must be loopback HTTP origins. Local mode is rejected for staging/production.
- Trace exports contain safe operation metadata, correlation IDs, query fingerprints, and timing. Raw SQL, URLs, headers, arguments, exception details, and workflow IDs are removed. Metrics use bounded dimensions and hashed pool IDs. Profiles contain function names and source paths.

The Docker image is pinned by digest. Update it deliberately and rerun `observe:verify` when changing versions. This bundled stack is intended for development/testing. The application uses OpenTelemetry so the instrumentation can later target a separately configured production backend.
