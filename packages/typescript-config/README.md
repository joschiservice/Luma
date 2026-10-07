# @luma/typescript-config

Shared strict TypeScript settings for Node and React workspaces.

`base.json` defines shared strictness. `node.json` selects NodeNext modules and resolution. `react.json` selects bundler resolution, React JSX, DOM types and no-emit checking. Keep package-specific paths, inputs and build output in the consuming workspace. The package has no build or tests; workspace typechecking validates it through consumers.

```json
{
  "extends": "@luma/typescript-config/node.json"
}
```

## Further reading

- [Local development](../../docs/development.md)
