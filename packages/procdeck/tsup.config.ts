import { defineConfig } from "tsup"

// Node can strip types from a `.ts` file it runs directly, but *not* from files
// inside node_modules — an installed package must therefore ship JS. esbuild
// (via tsup) does the transform; declarations come from `tsc -p
// tsconfig.build.json`, because the .d.ts surface is only `src/config.ts`.
//
// `src/config.ts` is a second entry so consumers can `import { defineConfig }
// from "procdeck"` in their `procdeck.config.ts`; splitting keeps the shared
// code in one chunk instead of duplicating it into the CLI bundle.
export default defineConfig({
  entry: ["src/cli.ts", "src/public.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: true,
  clean: true,
  // Everything is bundled except the PTY bindings: a native addon has to be
  // resolved from the consumer's node_modules. effect (and the Node service
  // layers the cli runtime needs) declare `sideEffects: []` and tree-shake
  // down to the handful of modules the CLI actually touches, which keeps them
  // out of the install entirely.
  // (tsup externalises every `dependencies` entry by default, so bundling one
  // has to be requested explicitly.)
  external: ["@lydell/node-pty"],
  noExternal: ["effect", "@effect/platform-node-shared"]
})
