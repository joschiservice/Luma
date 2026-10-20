# syntax=docker/dockerfile:1.7
# One server image runs the API, the workflow worker, commerce sync, the web server, the staff
# API and the deploy steps; each container chooses its command. JavaScript builds on the build
# platform, so a cross-architecture build emulates only the Code Steps runtime installation.
ARG NODE_IMAGE=node:24.22.0-trixie-slim

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ARG TARGETARCH
ENV CI=true npm_config_store_dir=/pnpm/store
RUN npm install --global pnpm@12.14.0
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=luma-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm exec turbo run build \
    --filter=@luma/api --filter=@luma/worker --filter=@luma/web \
    --filter=@luma/staff-api --filter=@luma/staff-web
# Reinstall production dependencies only, with native optional packages for the target
# platform. A fresh install leaves no development packages behind in the virtual store.
RUN --mount=type=cache,id=luma-pnpm-store,target=/pnpm/store \
    find . -name node_modules -type d -prune -exec rm -rf {} + \
    && pnpm install --prod --frozen-lockfile --os=linux --libc=glibc \
    --cpu="$([ "$TARGETARCH" = arm64 ] && echo arm64 || echo x64)"

FROM ${NODE_IMAGE} AS server
ENV NODE_ENV=production LUMA_CODE_RUNTIME_DIR=/opt/luma/code-runtime
# xz unpacks the Wasmtime release; prlimit (util-linux) bounds each Code Step child process.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && test -x /usr/bin/prlimit
WORKDIR /app
COPY --from=build /repo /app
# The installer creates its directories owner-only; the node user must read and run the runtime.
RUN install -d -m 0755 /opt/luma \
    && node tooling/code-runtime/setup.mjs \
    && chmod -R a+rX "$LUMA_CODE_RUNTIME_DIR"
USER node
