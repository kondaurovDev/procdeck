import { defineConfig } from "vite"

// `pnpm build` writes straight into the Go package that embeds the UI
// (internal/webui), so every procdeck binary carries the UI it was built with.
// UI development: `pnpm dev` → vite dev server with HMR, proxying the API to a
// running deck (same pattern as the repo's apps).
//
// No @foldkit/vite-plugin here: it wants vite ^7 and the repo pins ^6. The
// plugin only adds state-preserving HMR, so its absence just means full
// reloads during UI dev.
export default defineConfig({
  clearScreen: false,
  build: {
    outDir: "../internal/webui/dist",
    emptyOutDir: true
  },
  server: {
    port: 4821,
    proxy: {
      "/__procdeck": "http://localhost:4820",
      // Generated per deck by the server, not a static file.
      "/manifest.webmanifest": "http://localhost:4820"
    }
  }
})
