#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, statSync, unwatchFile, watchFile } from "node:fs"
import * as path from "node:path"
import { Console, Data, Effect, Layer, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime"
import * as NodeStdio from "@effect/platform-node-shared/NodeStdio"
import * as NodeTerminal from "@effect/platform-node-shared/NodeTerminal"
import { CONFIG_FILENAMES, DEFAULT_UI_PORT, loadConfig, locateConfig } from "./config.ts"
import type { LoadedConfig } from "./config.ts"
import type { ProcInfo } from "./events.ts"
import { detach, isPortFree, openBrowser, pretty, shutdown } from "./lifecycle.ts"
import {
  deregister,
  findByPort,
  findInstance,
  instanceId,
  listInstances,
  logPath,
  register,
} from "./registry.ts"
import type { Instance } from "./registry.ts"
import { makeSupervisor } from "./supervisor.ts"
import { serve } from "./server.ts"

const VERSION = (
  JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as {
    version: string
  }
).version

/** A user-facing failure: printed as one line, exit code 1, no stack. */
class CliFailure extends Data.TaggedError("CliFailure")<{ message: string }> {}
const fail = (message: string) => new CliFailure({ message })

// ---------------------------------------------------------------------------
// The server itself — `up --fg`, and what a detached `up` runs in the
// background. Registers in the instance registry once listening.
// ---------------------------------------------------------------------------

const explainListenError = (port: number, root: string) => (cause: Error) => {
  if ((cause as NodeJS.ErrnoException).code !== "EADDRINUSE") return fail(cause.message)
  const holder = findByPort(port)
  const who =
    holder === undefined
      ? "something else"
      : holder.root === root
        ? "another procdeck for this project (stale? try `procdeck down`)"
        : `deck "${holder.name}" (${pretty(holder.root)})`
  return fail(
    `port ${port} is taken by ${who} — set "port" in the config, or \`procdeck down\` there`,
  )
}

/**
 * `Effect.scoped` is the whole shutdown story: interrupting this fiber (Ctrl-C,
 * `procdeck down`, the UI's Shutdown — all SIGTERM) runs the finalizers in
 * reverse: deregister, close the server, terminate every process tree.
 */
const runServer = (loaded: LoadedConfig, configPath: string) =>
  Effect.gen(function* () {
    const port = loaded.config.port ?? DEFAULT_UI_PORT
    const mode: Instance["mode"] =
      process.env["PROCDECK_DETACHED"] === "1" ? "detached" : "foreground"
    const supervisor = yield* makeSupervisor(loaded)
    yield* serve(
      supervisor,
      { name: loaded.name, root: loaded.root, port, version: VERSION },
      {
        // Goes through the runtime's signal handling, same as Ctrl-C.
        shutdown: () => process.kill(process.pid, "SIGTERM"),
        instances: listInstances,
      },
    ).pipe(Effect.mapError(explainListenError(port, loaded.root)))
    const id = instanceId(loaded.root)
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        register({
          id,
          name: loaded.name,
          root: loaded.root,
          config: configPath,
          port,
          pid: process.pid,
          log: logPath(loaded.root),
          startedAt: Date.now(),
          version: VERSION,
          mode,
        }),
      ),
      () => Effect.sync(() => deregister(id)),
    )
    // Terminating every tree takes up to the SIGTERM grace period — say so,
    // or the pause reads as a hang. A second signal skips the graceful path.
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const onSignal = () => {
          Effect.runFork(Effect.log("shutting down, terminating processes… (Ctrl-C again to force)"))
          process.once("SIGINT", () => process.exit(1))
          process.once("SIGTERM", () => process.exit(1))
        }
        process.once("SIGINT", onSignal)
        process.once("SIGTERM", onSignal)
        return onSignal
      }),
      (onSignal) =>
        Effect.sync(() => {
          process.removeListener("SIGINT", onSignal)
          process.removeListener("SIGTERM", onSignal)
        }),
    )
    yield* Effect.log(
      `procdeck ${VERSION} "${loaded.name}" listening on http://localhost:${port} (pid ${process.pid}, ${mode})`,
    )
    yield* Effect.never
  }).pipe(Effect.scoped)

// ---------------------------------------------------------------------------
// Helpers shared by the commands
// ---------------------------------------------------------------------------

const url = (instance: Instance): string => `http://localhost:${instance.port}`

/** The config file: the given path, else the nearest one up from the cwd. */
const resolveConfig = (configArg: Option.Option<string>) =>
  Effect.gen(function* () {
    const found = Option.isSome(configArg)
      ? path.resolve(configArg.value)
      : locateConfig(process.cwd())
    if (found === undefined) {
      return yield* fail(
        `no config file here or above — expected one of ${CONFIG_FILENAMES.join(", ")} (or pass a path)`,
      )
    }
    if (!existsSync(found)) return yield* fail(`config file not found: ${found}`)
    // Real path: the project's identity must not depend on symlinks in the
    // way the config was reached (`/var` vs `/private/var` on macOS).
    return realpathSync(found)
  })

const load = (configPath: string) =>
  loadConfig(configPath).pipe(
    Effect.mapError((error) => fail(`${pretty(error.file)}: ${error.message}`)),
  )

/** The project root for `down|status|open|logs`: where the config lives. */
const resolveRoot = (configArg: Option.Option<string>) =>
  resolveConfig(configArg).pipe(Effect.map(path.dirname))

/** The deck's procs, straight from its API. `undefined` when it does not answer. */
const fetchProcs = (instance: Instance): Effect.Effect<Array<ProcInfo> | undefined> =>
  Effect.promise(async () => {
    try {
      const response = await fetch(`${url(instance)}/__procdeck/api/procs`, {
        signal: AbortSignal.timeout(1500),
      })
      if (!response.ok) return undefined
      return (await response.json()) as Array<ProcInfo>
    } catch {
      return undefined
    }
  })

const describeUptime = (since: number): string => {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
}

const countRunning = (procs: Array<ProcInfo> | undefined): string =>
  procs === undefined
    ? "not answering"
    : `${procs.filter((info) => info.status.state === "running").length}/${procs.length} running`

const describeProc = (info: ProcInfo): string => {
  const status = info.status
  switch (status.state) {
    case "running":
      return `running${status.restarts ? ` ↻${status.restarts}` : ""}`
    case "exited":
      return status.signal !== undefined
        ? `killed (${status.signal})`
        : `exit ${status.exitCode ?? "?"}`
    default:
      return status.state
  }
}

const table = (rows: Array<Array<string>>): string => {
  const widths = rows.reduce<Array<number>>(
    (acc, row) => row.map((cell, i) => Math.max(acc[i] ?? 0, cell.length)),
    [],
  )
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const configArgument = Argument.string("config").pipe(
  Argument.optional,
  Argument.withDescription(
    `config file (default: the nearest ${CONFIG_FILENAMES[0]} / .ts / .js / .mjs up from the current directory)`,
  ),
)
const fgFlag = Flag.boolean("fg").pipe(
  Flag.withDescription("run in the foreground — Ctrl-C stops the deck"),
)
const openFlag = Flag.boolean("open").pipe(
  Flag.withDefault(true),
  Flag.withDescription("open the UI in the browser (--no-open to skip)"),
)

const upHandler = ({
  config,
  fg,
  open,
}: {
  config: Option.Option<string>
  fg: boolean
  open: boolean
}) =>
  Effect.gen(function* () {
    const configPath = yield* resolveConfig(config)
    const loaded = yield* load(configPath)
    if (fg) return yield* runServer(loaded, configPath)

    const running = findInstance(loaded.root)
    if (running !== undefined) {
      yield* Console.log(
        `procdeck: "${running.name}" is already up → ${url(running)} (pid ${running.pid})`,
      )
      if (open) openBrowser(url(running))
      return
    }
    const port = loaded.config.port ?? DEFAULT_UI_PORT
    const holder = findByPort(port)
    if (holder !== undefined) {
      return yield* fail(
        `port ${port} is taken by deck "${holder.name}" (${pretty(holder.root)}) — set "port" in the config, or \`procdeck down\` there`,
      )
    }
    // Probe the port here, in the terminal, rather than let the child find
    // out and die in its log file.
    if (!(yield* Effect.promise(() => isPortFree(port)))) {
      return yield* fail(`port ${port} is busy (not a procdeck deck) — set "port" in the config`)
    }

    const instance = yield* Effect.tryPromise({
      try: () => detach(process.argv[1]!, configPath, loaded.root),
      catch: (cause) => fail((cause as Error).message),
    })
    yield* Console.log(`procdeck: "${instance.name}" is up → ${url(instance)}`)
    yield* Console.log(`  pid ${instance.pid} · log ${pretty(instance.log)}`)
    yield* Console.log("  procdeck down · status · logs -f · open")
    if (open) openBrowser(url(instance))
  })

const downHandler = ({ config }: { config: Option.Option<string> }) =>
  Effect.gen(function* () {
    const root = yield* resolveRoot(config)
    const instance = findInstance(root)
    if (instance === undefined) {
      yield* Console.log(`procdeck: nothing is up for ${pretty(root)}`)
      return
    }
    process.stdout.write(`procdeck: stopping "${instance.name}" (pid ${instance.pid})… `)
    const outcome = yield* Effect.promise(() => shutdown(instance))
    yield* Console.log(outcome === "stopped" ? "down" : "did not stop in time, killed")
  })

const up = Command.make("up", { config: configArgument, fg: fgFlag, open: openFlag }, upHandler).pipe(
  Command.withDescription(
    "Start the deck and open its UI. Detaches by default: the deck keeps running after the terminal closes (`procdeck down` stops it). Idempotent — an already-running deck is just opened.",
  ),
)

const down = Command.make("down", { config: configArgument }, downHandler).pipe(
  Command.withDescription("Stop the deck: every process tree is terminated, then procdeck exits."),
)

const restart = Command.make(
  "restart",
  { config: configArgument, fg: fgFlag, open: openFlag },
  (input) => downHandler(input).pipe(Effect.andThen(upHandler(input))),
).pipe(Command.withDescription("`down`, then `up` — e.g. after updating procdeck or editing the config."))

const status = Command.make("status", { config: configArgument }, ({ config }) =>
  Effect.gen(function* () {
    const root = yield* resolveRoot(config)
    const instance = findInstance(root)
    if (instance === undefined) return yield* fail(`nothing is up for ${pretty(root)}`)
    const procs = yield* fetchProcs(instance)
    yield* Console.log(
      `${instance.name} · ${url(instance)} · up ${describeUptime(instance.startedAt)} · pid ${instance.pid} · ${countRunning(procs)}${instance.mode === "foreground" ? " · foreground" : ""}`,
    )
    if (procs === undefined || procs.length === 0) return
    yield* Console.log(
      table(
        procs.map((info) => [
          `  ${info.id}`,
          describeProc(info),
          info.proxyUrl ?? "",
          info.status.alert === undefined ? "" : `⚠ ${info.status.alert}`,
        ]),
      ),
    )
  }),
).pipe(Command.withDescription("This project's deck: address, uptime, and every proc's state."))

const ls = Command.make("ls", {}, () =>
  Effect.gen(function* () {
    const instances = listInstances()
    if (instances.length === 0) return yield* Console.log("procdeck: no decks are up")
    const procs = yield* Effect.all(instances.map(fetchProcs), { concurrency: "unbounded" })
    yield* Console.log(
      table(
        instances.map((instance, i) => [
          instance.name,
          `:${instance.port}`,
          `up ${describeUptime(instance.startedAt)}`,
          countRunning(procs[i]),
          pretty(instance.root),
        ]),
      ),
    )
  }),
).pipe(Command.withDescription("Every running deck on this machine."))

const open = Command.make("open", { config: configArgument }, ({ config }) =>
  Effect.gen(function* () {
    const root = yield* resolveRoot(config)
    const instance = findInstance(root)
    if (instance === undefined) {
      return yield* fail(`nothing is up for ${pretty(root)} — \`procdeck up\` first`)
    }
    yield* Console.log(`procdeck: opening ${url(instance)}`)
    openBrowser(url(instance))
  }),
).pipe(Command.withDescription("Open the deck's UI in the browser — no port to remember."))

const logs = Command.make(
  "logs",
  {
    config: configArgument,
    follow: Flag.boolean("follow").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("keep printing new lines"),
    ),
  },
  ({ config, follow }) =>
    Effect.gen(function* () {
      const root = yield* resolveRoot(config)
      const file = logPath(root)
      if (!existsSync(file)) {
        return yield* fail(`no log yet for ${pretty(root)} (${pretty(file)})`)
      }
      const lines = readFileSync(file, "utf8").trimEnd().split("\n")
      yield* Console.log(lines.slice(-200).join("\n"))
      if (!follow) return
      // Poll-based follow: portable, and the file only grows. Ctrl-C
      // interrupts the fiber; the finalizer stops watching.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          let offset = statSync(file).size
          const onChange = (current: { size: number }) => {
            if (current.size < offset) offset = 0
            if (current.size === offset) return
            const chunk = readFileSync(file).subarray(offset, current.size)
            offset = current.size
            process.stdout.write(chunk)
          }
          watchFile(file, { interval: 300 }, onChange)
          return onChange
        }),
        (onChange) => Effect.sync(() => unwatchFile(file, onChange)),
      )
      yield* Effect.never
    }).pipe(Effect.scoped),
).pipe(Command.withDescription("procdeck's own log — startup, shutdown, errors (not pane output)."))

// `procdeck [config]` with no subcommand is `up`, so the one-liner from the
// README keeps working: `npx procdeck`.
const procdeck = Command.make(
  "procdeck",
  { config: configArgument, fg: fgFlag, open: openFlag },
  upHandler,
).pipe(
  Command.withDescription(
    "Dev-process multiplexer with a web UI. Without a subcommand, `procdeck` is `procdeck up`.",
  ),
  Command.withSubcommands([up, down, restart, status, ls, open, logs]),
)

// The services the cli runtime expects (help rendering, args, completions).
const NodeLayer = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeStdio.layer, NodeTerminal.layer),
  ),
)

procdeck.pipe(
  Command.run({ version: VERSION }),
  Effect.catchTag("CliFailure", (failure) =>
    Console.error(`procdeck: ${failure.message}`).pipe(
      Effect.andThen(Effect.sync(() => {
        process.exitCode = 1
      })),
    ),
  ),
  Effect.provide(NodeLayer),
  NodeRuntime.runMain,
)
