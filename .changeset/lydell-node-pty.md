---
"procdeck": minor
---

Cut the install from 116 MB to 1.8 MB, and remove every reason for it to fail.

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
