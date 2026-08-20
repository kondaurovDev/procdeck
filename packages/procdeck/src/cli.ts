#!/usr/bin/env node
import { existsSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { Console, Effect, Layer, Option } from "effect"
import { Argument, CliConfig, Command, Flag, GlobalFlag } from "effect/unstable/cli"
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime"
import * as NodeStdio from "@effect/platform-node-shared/NodeStdio"
import * as NodeTerminal from "@effect/platform-node-shared/NodeTerminal"
import { apiGet, apiPost, deckUrl as url, describeProc, statusReport } from "./agent/client.ts"
import { appendSnippet, findInstructionsFile } from "./agent/discover.ts"
import { agents, errors, logs, mark, mcp, waitFor } from "./commands/agent.ts"
import { http } from "./commands/http.ts"
import {
  callApi,
  configArgument,
  countRunning,
  describeUptime,
  fail,
  fetchProcs,
  jsonFlag,
  load,
  requireInstance,
  resolveConfig,
  resolveRoot,
  table,
} from "./commands/shared.ts"
import { CONFIG_FILENAMES, DEFAULT_UI_HOST, DEFAULT_UI_PORT, discoverConfig } from "./config.ts"
import type { LoadedConfig } from "./config.ts"
import type { ProcInfo } from "./events.ts"
import { planInit } from "./init.ts"
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
import { VERSION } from "./version.ts"

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
    const host = loaded.config.host ?? DEFAULT_UI_HOST
    const mode: Instance["mode"] =
      process.env["PROCDECK_DETACHED"] === "1" ? "detached" : "foreground"
    const supervisor = yield* makeSupervisor(loaded)
    yield* serve(
      supervisor,
      { name: loaded.name, root: loaded.root, port, version: VERSION },
      { host, port },
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
    // The log line runs with this fiber's services, so `--log-level` applies.
    const services = yield* Effect.context<never>()
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const onSignal = () => {
          Effect.runForkWith(services)(
            Effect.log("shutting down, terminating processes… (Ctrl-C again to force)"),
          )
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
      `procdeck ${VERSION} "${loaded.name}" listening on http://localhost:${port}${host === DEFAULT_UI_HOST ? "" : ` (bound to ${host})`} (pid ${process.pid}, ${mode})`,
    )
    yield* Effect.never
  }).pipe(Effect.scoped)

// ---------------------------------------------------------------------------
// Deck lifecycle commands. The agent-facing ones (logs, mark, wait-for,
// errors, agents, mcp) live in commands/agent.ts.
// ---------------------------------------------------------------------------

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
    if (!(yield* Effect.promise(() => isPortFree(port, loaded.config.host ?? DEFAULT_UI_HOST)))) {
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
  {
    proc: Argument.string("proc").pipe(
      Argument.optional,
      Argument.withDescription("proc id — restart just this process (default: the whole deck)"),
    ),
    fg: fgFlag,
    open: openFlag,
  },
  ({ fg, open, proc }) =>
    Option.isSome(proc)
      ? Effect.gen(function* () {
          const instance = yield* requireInstance(Option.none())
          const procs = yield* callApi(() => apiGet<Array<ProcInfo>>(instance, "/procs"))
          if (!procs.some((info) => info.id === proc.value)) {
            return yield* fail(
              `unknown proc "${proc.value}" — one of: ${procs.map((info) => info.id).join(", ")}`,
            )
          }
          yield* callApi(() =>
            apiPost(instance, `/procs/${encodeURIComponent(proc.value)}/restart`, {}),
          )
          yield* Console.log(
            `procdeck: "${proc.value}" restarted — \`procdeck wait-for ${proc.value}\` to await readiness`,
          )
        })
      : downHandler({ config: Option.none() }).pipe(
          Effect.andThen(upHandler({ config: Option.none(), fg, open })),
        ),
).pipe(
  Command.withDescription(
    "Restart one proc (`restart api`), or the whole deck (`restart`) — the latter after updating procdeck or editing the config.",
  ),
)

const status = Command.make(
  "status",
  { config: configArgument, json: jsonFlag },
  ({ config, json }) =>
    Effect.gen(function* () {
      const root = yield* resolveRoot(config)
      const instance = findInstance(root)
      if (instance === undefined) {
        if (!json) return yield* fail(`nothing is up for ${pretty(root)}`)
        yield* Console.log(JSON.stringify({ up: false, root }))
        return yield* Effect.sync(() => {
          process.exitCode = 1
        })
      }
      if (json) {
        const report = yield* Effect.promise(() => statusReport(instance))
        return yield* Console.log(JSON.stringify(report))
      }
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
).pipe(
  Command.withDescription(
    "This project's deck: address, uptime, and every proc's state. `--json` adds an `attention` list (crashed / blocked / alerting procs) — the cheapest first question for an agent.",
  ),
)

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

const init = Command.make(
  "init",
  {
    force: Flag.boolean("force").pipe(Flag.withDescription("overwrite an existing config")),
  },
  ({ force }) =>
    Effect.gen(function* () {
      const root = process.cwd()
      const existing = discoverConfig(root)
      if (existing !== undefined && !force) {
        return yield* fail(`${path.basename(existing)} already exists here (--force to overwrite)`)
      }
      const plan = planInit(root)
      const file = path.join(root, CONFIG_FILENAMES[0])
      writeFileSync(file, `${JSON.stringify(plan.config, null, 2)}\n`)
      // Round-trip through the real loader: what we wrote must be a valid deck.
      yield* load(file)
      yield* Console.log(
        `procdeck: wrote ${CONFIG_FILENAMES[0]} — ${plan.config.procs.length} proc${plan.config.procs.length === 1 ? "" : "s"} from ${plan.source}`,
      )
      yield* Console.log(plan.notes.map((note) => `  ${note}`).join("\n"))
      // A project that already instructs agents gets the procdeck section
      // for free — that is how the agent learns the deck exists.
      const instructions = findInstructionsFile(root)
      if (instructions !== undefined && appendSnippet(instructions) === "appended") {
        yield* Console.log(
          `  ${path.basename(instructions)} — added a "## procdeck" section for coding agents`,
        )
      }
      yield* Console.log(
        [
          "",
          "next: `procdeck up`",
          'tip:  "env": { "PORT": "${port}" } hands a proc a free port (also as ${port:id} for others),',
          '      "needs": ["api"] makes a proc wait for another — see https://github.com/kondaurovDev/procdeck#config',
          ...(instructions === undefined
            ? ["tip:  `procdeck agents` introduces the deck to coding agents (CLAUDE.md + a skill)"]
            : []),
        ].join("\n"),
      )
    }),
).pipe(
  Command.withDescription(
    "Write a procdeck.config.json for this project from what is already there: a Procfile, workspace packages with dev scripts, plain subdirectories (each its own package.json / Django / Go / Rust / Rails / compose project), or the root itself.",
  ),
)

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
  Command.withSubcommands([
    init,
    up,
    down,
    restart,
    status,
    ls,
    open,
    logs,
    http,
    mark,
    waitFor,
    errors,
    agents,
    mcp,
  ]),
)

// The services the cli runtime expects (help rendering, args, completions),
// plus its built-in global flags minus `--wizard` — an interactive prompt
// for a seven-word command line is clutter. `--log-level` stays: with `--fg`
// the deck's own logs are right there in the terminal.
const NodeLayer = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeFileSystem.layer,
      NodePath.layer,
      NodeStdio.layer,
      NodeTerminal.layer,
      CliConfig.layer({
        builtIns: [
          GlobalFlag.Help,
          GlobalFlag.Version,
          GlobalFlag.Completions,
          GlobalFlag.LogLevel,
        ],
      }),
    ),
  ),
)

procdeck.pipe(
  Command.run({ version: VERSION }),
  Effect.catchTag("CliFailure", (failure) =>
    Console.error(`procdeck: ${failure.message}`).pipe(
      Effect.andThen(Effect.sync(() => {
        process.exitCode = failure.code ?? 1
      })),
    ),
  ),
  Effect.provide(NodeLayer),
  NodeRuntime.runMain,
)
