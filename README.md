# Luma

TypeScript modular monolith foundation. Node.js 24, pnpm 10, Turborepo.

## Start locally

```sh
nvm install
nvm use
corepack enable
corepack install
pnpm install --frozen-lockfile
pnpm --filter @luma/ui exec playwright install chromium
pnpm dev
```

`packageManager` pins pnpm. If Corepack is unavailable, install the pinned version with `npm install --global pnpm@10.34.5`.

Web: http://localhost:3000. API: http://127.0.0.1:3001/health.
No secrets, database, or external services are needed. Stop both with Ctrl+C.

## Quality gates

Run these from the repository root, including on a clean checkout:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm check` runs all five. `pnpm format` applies formatting. CI runs the same gates after a frozen-lockfile install on Node 24. Typechecking generates the web route tree automatically; shared libraries build before dependent tasks. Tests use Vitest and fail if no tests are found.

## Structure

| Path                         | Purpose                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `apps/web`                   | TanStack Start + React; minimal server-rendered landing page |
| `apps/api`                   | Fastify process and service-free `/health` endpoint          |
| `packages/ui`                | Reusable React components and Storybook component tests      |
| `packages/config`            | Validated server environment configuration                   |
| `packages/typescript-config` | Strict shared TypeScript settings for Node and React         |

Apps depend on packages through `workspace:*`; packages must not import apps. Keep domain features in explicit modules. Add shared packages only when they have a concrete consumer. Configuration packages are checked by their consuming builds and formatting/linting gates; runtime packages each have build, typecheck, and test scripts.

API build output is `apps/api/dist`; run with `pnpm --filter @luma/api start` after `pnpm build`. Shared config exports compiled JavaScript and declarations. Web builds produce `apps/web/dist/client` and `apps/web/dist/server`; a hosting adapter is a later deployment concern.

## Environment

Optional overrides belong in the consuming app's `.env`; copy its `.env.example` first. API dev/start commands load that file; Vite loads web environment files. Real `.env` files are ignored. Document every new setting in the corresponding example, validate server settings at startup, and inject production secrets through the deployment environment.

API defaults: `HOST=127.0.0.1`, `PORT=3001`, `LOG_LEVEL=info`. Containers must explicitly set `HOST=0.0.0.0`. `PORT` must be 1–65535; `LOG_LEVEL` must be a supported Fastify/Pino level. `VITE_*` variables are public: never use them for credentials. Server configuration must not be imported into the web client.

Turborepo runs in strict environment mode. Add new runtime variable names to task `env` in `turbo.json`, especially variables used during builds so their values affect cache keys. Environment files already invalidate task caches. Builds and tests must not depend on production secrets.

## Contribution conventions

Branch from `main`: `feature/luma-<id>-<summary>`, `fix/luma-<id>-<summary>`, or `chore/luma-<id>-<summary>`. Use Conventional Commits, for example `chore(repo): bootstrap workspace`. PR titles should be concise and include the issue, for example `LUMA-3: Bootstrap monorepo`.

Link the Linear issue, describe behavior and validation, and keep PRs scoped. Run `pnpm check` before review. Commit `pnpm-lock.yaml` and the generated `apps/web/src/routeTree.gen.ts`; never edit the latter manually. Squash merge after review and passing CI. Once a GitHub remote exists, configure `Quality gates` as a required check on `main` and require review.

Architecture follows the [Linear decision register](https://linear.app/auren-labs/document/architecture-decision-register-305db9bed1de). The web bootstrap follows [TanStack Start's setup guide](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch). Contract-first API work belongs to LUMA-7; authentication and observability have separate follow-ups.

## UI workshop

```sh
pnpm storybook        # http://localhost:6006
pnpm test:ui          # stories + interactions + accessibility in headless Chromium
pnpm build:storybook  # static workshop in packages/ui/storybook-static
```

`pnpm test` includes component tests; `pnpm build` includes the workshop. Install Chromium once using the setup command above (CI installs it with system dependencies). Storybook uses the React/Vite renderer without the TanStack Start server plugin, so no API, secrets or running application are needed. Only the Vitest and accessibility addons are installed; accessibility violations fail tests.

Reusable components and their `*.stories.tsx` files live together in `packages/ui/src/components`. Import components in the web app through explicit package exports, for example `import { Button } from '@luma/ui/button'`. This internal package exports React/TypeScript source for Vite to bundle and typecheck; its build also emits declarations. Import `@luma/ui/styles.css` once in each host and enable the Tailwind Vite plugin. The app and workshop share the same Luma tokens and component styles.

Use `button.stories.tsx` as the example: default, keyboard, disabled and composed pending states share the real Base UI component. Input, dialog and spinner stories cover the other starter primitives. Add named stories for meaningful UI states and `play` assertions for important interactions. Keep fixtures deterministic and pass state through props. Keep data fetching, auth, mutations and business decisions in the application; stories must not reimplement them. Add a local decorator only when a component needs a provider (for example an in-memory TanStack router). Do not wrap every story in the application root.

Automated accessibility checks complement keyboard and manual review; they do not establish full accessibility compliance. The integration follows the [Storybook Vitest guide](https://storybook.js.org/docs/writing-tests/integrations/vitest-addon) and [accessibility test guidance](https://storybook.js.org/docs/writing-tests/accessibility-testing).

See [UI package conventions](packages/ui/README.md) for tokens, Base UI composition, adding components and future Tauri/React consumers.
