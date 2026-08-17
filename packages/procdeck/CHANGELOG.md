# procdeck

## 0.2.0

### Minor Changes

- 212de8d: Accept `procdeck.config.json` next to the TypeScript config, validated by the same schema.
  A JSON deck needs nothing from the project's toolchain — no TypeScript, and procdeck itself
  does not have to be a dependency, so `npx procdeck` works in any repo. Point `$schema` at
  `https://unpkg.com/procdeck/schema.json` (generated from the Effect schema at build time and
  shipped with the package) for completion and validation in the editor.

  Started without an argument, the CLI now looks for `procdeck.config.json`, `.ts`, `.js` and
  `.mjs` in that order, and reports a missing or unreadable config against the file instead of
  crashing. `port` is validated as an integer in 1–65535.
