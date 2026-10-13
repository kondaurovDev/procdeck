import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globalSetup: ["./global-setup.ts"],
    // Real decks need room: spawn, readiness polls, SIGTERM grace periods.
    testTimeout: 15_000,
    hookTimeout: 60_000
  }
})
