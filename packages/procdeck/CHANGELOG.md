# procdeck

## 0.3.0

### Minor Changes

- a1ced2e: Cut the install from 116 MB to 1.8 MB, and remove every reason for it to fail.

  `node-pty` is replaced by `@lydell/node-pty` — the same upstream sources and the same API,
  but the binaries ship as per-platform optional dependencies instead of one tarball carrying
  every platform's prebuilds. Upstream runs an install script and has no Linux prebuild at
  all, so Linux users needed a C++ toolchain and pnpm ≥ 10 / Bun users needed
  `pnpm approve-builds` (or `trustedDependencies`) on every platform or spawning failed at
  runtime. The replacement runs no install script and compiles nothing, anywhere — which also
  retires the startup hack that repaired the darwin `spawn-helper` execute bit.

  `effect` is no longer installed either: it is bundled into the CLI, where tree-shaking takes
  it from 48 MB on disk to under 1 MB of shipped code. The package's public entry point
  (`defineConfig` and the config types) is now a standalone module with no effect types in its
  declarations, so a `procdeck.config.ts` typechecks against a package that has none of
  procdeck's own dependencies installed.

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
