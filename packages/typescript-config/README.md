# @luma/typescript-config

Shares strict TypeScript settings across Node and React workspaces.

## Responsibilities

base.json defines shared strictness. node.json selects NodeNext modules and resolution. react.json selects bundler resolution, React JSX, DOM types, and no-emit checking. Keep package-specific paths, inputs, and build output in the consuming workspace.

## Usage

Extend `@luma/typescript-config/node.json` for Node packages or `@luma/typescript-config/react.json` for React applications. Both extend [base.json](base.json).

```json
{
  "extends": "@luma/typescript-config/node.json"
}
```

## Development

Run commands from the repository root after installing workspace dependencies.

```sh
pnpm typecheck
```

This package has no build or test script. Workspace typechecking validates its settings through consumers.

## Further reading

- [Engineering guide](../../docs/development.md)
- [Package boundaries and runtime composition](../../docs/architecture/005-domain-packages-and-runtimes.md)
