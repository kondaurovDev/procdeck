#!/usr/bin/env node
import { Effect, Fiber } from "effect"
import { CONFIG_FILENAMES, DEFAULT_UI_PORT, discoverConfig, loadConfig } from "./config.ts"
import { makeSupervisor } from "./supervisor.ts"
import { serve } from "./server.ts"

// Without an argument, take whichever config file the directory has.
const configPath = process.argv[2] ?? discoverConfig(process.cwd())

if (configPath === undefined) {
  console.error(`procdeck: no config file here — expected one of ${CONFIG_FILENAMES.join(", ")}`)
  process.exit(1)
}

const main = Effect.gen(function* () {
  const loaded = yield* loadConfig(configPath)
  const supervisor = yield* makeSupervisor(loaded)
  const port = yield* serve(supervisor, loaded.config.port ?? DEFAULT_UI_PORT, { name: loaded.name })
  yield* Effect.log(`procdeck listening on http://localhost:${port}`)
  yield* Effect.never
})

// `Effect.scoped` is the whole shutdown story: interrupting this fiber runs the
// supervisor's finalizer, which terminates every process tree it spawned.
// Startup failures (bad config, busy port) are logged explicitly — otherwise
// the process would just exit with nothing on the screen.
const program = Effect.scoped(main).pipe(
  Effect.catchCause((cause) =>
    Effect.gen(function* () {
      yield* Effect.logError("procdeck failed", cause)
      process.exitCode = 1
    }),
  ),
)

const fiber = Effect.runFork(program)

let shuttingDown = false
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Second signal means "stop waiting for the graceful path".
    if (shuttingDown) process.exit(1)
    shuttingDown = true
    // Terminating every tree takes up to the SIGTERM grace period — say so,
    // or the pause reads as a hang and invites the second Ctrl-C.
    Effect.runFork(Effect.log("shutting down, terminating processes… (Ctrl-C again to force)"))
    Effect.runPromise(Fiber.interrupt(fiber)).then(
      () => process.exit(0),
      () => process.exit(1),
    )
  })
}
