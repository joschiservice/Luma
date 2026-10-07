# Luma

Luma helps commerce teams detect operational issues, investigate their causes, and resolve
them through policy-controlled actions and workflows. Provider observations, canonical
records, approvals, execution and fresh verification form one traceable path.

It is a TypeScript modular monolith: a Fastify/ts-rest API, a TanStack Start/React web app,
separate Temporal and sync workers, and PostgreSQL. Node.js 24, pnpm and Turborepo.

## Start locally

Install [mise](https://mise.jdx.dev/getting-started.html) and start a Docker-compatible
runtime with Compose v2, then:

```sh
mise trust
mise install
mise run setup
mise run dev
```

Setup installs dependencies and Chromium, starts PostgreSQL, applies migrations, provisions
restricted database logins and seeds a demo workspace. No provider credentials are needed.
The command prints this checkout's URLs; demo credentials are in `.luma/demo.json`. Each
worktree has its own ports, credentials and database.

For synthetic Shopify and JTL environments that exercise the real services, run
`pnpm simulator` or the [pilot](docs/pilot-environment.md).

## Check a change

```sh
pnpm check       # format, lint, unused code, types, tests, builds
pnpm test:e2e    # backend journeys
pnpm test:browser
pnpm test:full   # every CI gate
```

Tests start a disposable PostgreSQL through Testcontainers and never touch the development
database. See [local development](docs/development.md) for focused checks, configuration and
troubleshooting.

## Find your way

- [AGENTS.md](AGENTS.md): working rules for people and coding agents.
- [Codebase map](docs/codebase-map.md): which package owns what, and the conventions that
  make the rest searchable.
- [Engineering guides](docs/README.md): feature rules, limits and procedures.
- [Architecture decisions](docs/architecture/README.md).
- Product guides for Luma's users: `apps/web/content/docs`.

## Contributing

Branch from `main` as `feat/LUMA-<id>-<short-description>`, use Conventional Commits, and
title pull requests `LUMA-<id>: <summary>`. Link the Linear issue, describe the behavior
change and its validation, and run `pnpm check` before review. Commit lockfile and
generated route-tree changes. Pull requests squash-merge after review and a passing
`Quality gates` check.
