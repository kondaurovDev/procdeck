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
  entry: ["src/cli.ts", "src/config.ts"],
  outDir: "dist",
  format: ["esm"],
  target: "node22",
  platform: "node",
  splitting: true,
  clean: true,
  // node-pty is a native addon and effect is a runtime dependency: both are
  // resolved from the consumer's node_modules, never bundled.
  external: ["node-pty", "effect"],
})
