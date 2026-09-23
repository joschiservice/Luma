# @luma/simulator-web

Provides the static HTML, JavaScript, and CSS control panel served by the simulator host.

## Responsibilities

The panel uses the simulator control API. Scheduling, persistence, and provider behavior belong to the host and simulator packages. This workspace has no independent build or server.

## Entry points

- [src/index.html](src/index.html)
- [src/app.js](src/app.js)
- [src/style.css](src/style.css)

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm simulator
pnpm test:simulator
```

## Further reading

- [Engineering guide](../../docs/simulator.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
