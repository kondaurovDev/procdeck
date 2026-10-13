#!/usr/bin/env node
"use strict"

// procdeck's npm entry. The binary for this machine ships as an optional
// dependency — @procdeck/<os>-<arch> — so the package manager installs only
// the one that fits, with no install scripts. This launcher finds it and runs
// it with the same arguments, terminal and exit code.

const { spawn } = require("node:child_process")

const supported = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]
const target = `${process.platform}-${process.arch}`

const fail = (message) => {
  console.error(`procdeck: ${message}`)
  process.exit(1)
}

const binary = () => {
  // A binary built from source, for trying a change through this launcher.
  if (process.env.PROCDECK_BINARY) return process.env.PROCDECK_BINARY
  if (!supported.includes(target)) {
    fail(`no binary for ${target} — supported: ${supported.join(", ")}`)
  }
  try {
    return require.resolve(`@procdeck/${target}/bin/procdeck`)
  } catch {
    fail(
      `@procdeck/${target} is missing — it carries the procdeck binary for this machine. ` +
        "Reinstall without --no-optional / --omit=optional."
    )
  }
}

const child = spawn(binary(), process.argv.slice(2), { stdio: "inherit" })

// Pass signals on rather than dying of them: the binary decides how to stop
// (a deck tears its processes down first). A Ctrl-C reaches the binary from
// the terminal as well; it reads a repeat within a moment as the same press.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal))
}

child.on("error", (cause) => fail(cause.message))
child.on("exit", (code, signal) => {
  if (signal === null) process.exit(code ?? 1)
  // Die of the same signal, so the caller sees what the binary saw.
  process.removeAllListeners(signal)
  process.kill(process.pid, signal)
})
