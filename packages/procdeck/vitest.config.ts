import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Real processes need room: spawn + grace period + SIGKILL polling.
    testTimeout: 15_000,
    // node-pty is a native addon; worker threads and native addons are a known
    // bad mix, so run test files in forked processes instead.
    pool: "forks"
  }
})
