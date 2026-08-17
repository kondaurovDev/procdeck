import { defineConfig } from "vite"

// Normal usage: `pnpm build` → the procdeck server serves ui/dist statically.
// UI development: `pnpm ui:dev` → vite dev server with HMR, proxying the API
// to a running procdeck server (same pattern as the repo's apps).
//
// No @foldkit/vite-plugin here: it wants vite ^7 and the repo catalog pins ^6.
// The plugin only adds state-preserving HMR, so its absence just means full
// reloads during UI dev.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 4821,
    proxy: {
      "/__procdeck": "http://localhost:4820",
      // Generated per deck by the server, not a static file.
      "/manifest.webmanifest": "http://localhost:4820",
    },
  },
})
