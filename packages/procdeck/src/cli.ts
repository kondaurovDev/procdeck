#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs"
import * as path from "node:path"
import { Console, Data, Effect, Layer, Option } from "effect"
import { Argument, CliConfig, Command, Flag, GlobalFlag } from "effect/unstable/cli"
import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
import * as NodePath from "@effect/platform-node-shared/NodePath"
import * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime"
import * as NodeStdio from "@effect/platform-node-shared/NodeStdio"
import * as NodeTerminal from "@effect/platform-node-shared/NodeTerminal"
import {
  CONFIG_FILENAMES,
  DEFAULT_UI_HOST,
  DEFAULT_UI_PORT,
  discoverConfig,
  loadConfig,
  locateConfig,
} from "./config.ts"
import type { LoadedConfig } from "./config.ts"
import { findInstructionsFile, appendSnippet, setupAgents } from "./agents.ts"
import {
  apiGet,
  apiPost,
  attentionOf,
  deckUrl,
  describeProc,
  fetchProcs as fetchProcsRaw,
  logsParams,
  statusReport,
  waitForProc,
} from "./client.ts"
import { extractErrors } from "./errors.ts"
import type { ErrorGroup } from "./errors.ts"
import type { ProcInfo } from "./events.ts"
import type { LogsResult, Mark } from "./lines.ts"
import { runMcp } from "./mcp.ts"
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

const VERSION = (
  JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as {
    version: string
  }
).version

/** A user-facing failure: printed as one line, exit code 1, no stack. */
class CliFailure extends Data.TaggedError("CliFailure")<{
  message: string
  code?: number | undefined
}> {}
const fail = (message: string, code?: number) => new CliFailure({ message, code })

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
// Helpers shared by the commands
// ---------------------------------------------------------------------------

const url = deckUrl

/** A deck API promise as a CLI step: any thrown message is the failure line. */
const callApi = <T>(thunk: () => Promise<T>): Effect.Effect<T, CliFailure> =>
  Effect.tryPromise({ try: thunk, catch: (cause) => fail((cause as Error).message) })

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
  Effect.promise(() => fetchProcsRaw(instance))

/** The running deck for the current project, or a one-line failure. */
const requireInstance = (configArg: Option.Option<string>) =>
  Effect.gen(function* () {
    const root = yield* resolveRoot(configArg)
    const instance = findInstance(root)
    if (instance === undefined) {
      return yield* fail(`nothing is up for ${pretty(root)} — \`procdeck up\` first`)
    }
    return instance
  })

/** "30s" / "5m" / "2h" / bare seconds → ms. `undefined` = unparsable. */
const parseDuration = (raw: string): number | undefined => {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(raw.trim())
  if (match === null) return undefined
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? "s"]!
  return Number(match[1]) * scale
}

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

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("machine-readable output (for agents and scripts)"),
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

/** The deck's own daemon log — the old `procdeck logs`, now `logs --self`. */
const selfLogs = (follow: boolean) =>
  Effect.gen(function* () {
    const root = yield* resolveRoot(Option.none())
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
  }).pipe(Effect.scoped)

/** Assemble the /logs query string shared by `logs` and `errors`. */
const logsQuery = (options: {
  proc: Option.Option<string>
  lines: number
  grep: Option.Option<string>
  since: Option.Option<string>
  sinceMark: Option.Option<string>
}) =>
  Effect.gen(function* () {
    let sinceMs: number | undefined
    if (Option.isSome(options.since)) {
      const ms = parseDuration(options.since.value)
      if (ms === undefined) {
        return yield* fail(`bad --since "${options.since.value}" — try 30s, 5m, 2h`)
      }
      sinceMs = Date.now() - ms
    }
    return logsParams({
      proc: Option.getOrUndefined(options.proc),
      lines: options.lines,
      grep: Option.getOrUndefined(options.grep),
      sinceMs,
      mark: Option.getOrUndefined(options.sinceMark),
    })
  })

const logs = Command.make(
  "logs",
  {
    proc: Argument.string("proc").pipe(
      Argument.optional,
      Argument.withDescription("proc id (default: every proc, interleaved with [id] prefixes)"),
    ),
    lines: Flag.integer("lines").pipe(
      Flag.withAlias("n"),
      Flag.withDefault(200),
      Flag.withDescription("max lines — the most recent ones (default 200, max 5000)"),
    ),
    grep: Flag.string("grep").pipe(
      Flag.optional,
      Flag.withDescription("only lines matching this RegExp (case-insensitive)"),
    ),
    since: Flag.string("since").pipe(
      Flag.optional,
      Flag.withDescription("only lines newer than this — 30s, 5m, 2h"),
    ),
    sinceMark: Flag.string("since-mark").pipe(
      Flag.optional,
      Flag.withDescription("only lines after `procdeck mark <name>` was set"),
    ),
    json: jsonFlag,
    self: Flag.boolean("self").pipe(
      Flag.withDescription("procdeck's own daemon log instead of pane output"),
    ),
    follow: Flag.boolean("follow").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("keep printing new lines (with --self only, for now)"),
    ),
  },
  ({ follow, grep, json, lines, proc, self, since, sinceMark }) =>
    Effect.gen(function* () {
      if (self) return yield* selfLogs(follow)
      if (follow) return yield* fail("--follow works with --self only, for now")
      const instance = yield* requireInstance(Option.none())
      const params = yield* logsQuery({ proc, lines, grep, since, sinceMark })
      const result = yield* callApi(() => apiGet<LogsResult>(instance, `/logs?${params}`))
      if (json) return yield* Console.log(JSON.stringify(result))
      if (result.lines.length === 0) {
        return yield* Console.error("procdeck: no matching lines in the buffer")
      }
      const multi = Option.isNone(proc)
      if (result.omitted > 0) {
        yield* Console.log(`… ${result.omitted} earlier matching lines omitted (raise --lines)`)
      }
      yield* Console.log(
        result.lines
          .map((line) => (multi ? `[${line.proc}] ${line.text}` : line.text))
          .join("\n"),
      )
    }),
).pipe(
  Command.withDescription(
    "Recent output of the deck's processes: plain lines, filterable and bounded — made for agents as much as for humans. `--self` is procdeck's own daemon log.",
  ),
)

const mark = Command.make(
  "mark",
  {
    name: Argument.string("name").pipe(
      Argument.withDefault("default"),
      Argument.withDescription('mark name (default "default") — names keep two agents apart'),
    ),
    json: jsonFlag,
  },
  ({ json, name }) =>
    Effect.gen(function* () {
      const instance = yield* requireInstance(Option.none())
      const result = yield* callApi(() => apiPost<Mark>(instance, "/marks", { name }))
      if (json) return yield* Console.log(JSON.stringify(result))
      yield* Console.log(
        `procdeck: mark "${result.name}" set — read what happens next with \`procdeck logs --since-mark ${result.name}\``,
      )
    }),
).pipe(
  Command.withDescription(
    'Drop a named marker at "now" in every proc\'s output. The verify loop: mark → act (restart, hit an endpoint) → `logs --since-mark` shows only what your action caused.',
  ),
)

const waitFor = Command.make(
  "wait-for",
  {
    proc: Argument.string("proc").pipe(Argument.withDescription("proc id to wait for")),
    pattern: Flag.string("pattern").pipe(
      Flag.optional,
      Flag.withDescription(
        "succeed when this RegExp matches a new output line (default: wait for a listening port)",
      ),
    ),
    timeout: Flag.string("timeout").pipe(
      Flag.withDefault("30s"),
      Flag.withDescription("give up after this long (exit code 2)"),
    ),
  },
  ({ pattern, proc, timeout }) =>
    Effect.gen(function* () {
      const instance = yield* requireInstance(Option.none())
      const timeoutMs = parseDuration(timeout)
      if (timeoutMs === undefined) {
        return yield* fail(`bad --timeout "${timeout}" — try 30s, 5m`)
      }
      const outcome = yield* callApi(() =>
        waitForProc(instance, { proc, pattern: Option.getOrUndefined(pattern), timeoutMs }),
      )
      if (outcome.ok) return yield* Console.log(`procdeck: ${outcome.message}`)
      if (outcome.tail.length > 0) {
        yield* Console.error(outcome.tail.map((line) => `  ${line}`).join("\n"))
      }
      return yield* fail(
        outcome.kind === "crashed" ? `${outcome.reason} — last lines above` : outcome.reason,
        outcome.kind === "timeout" ? 2 : 1,
      )
    }),
).pipe(
  Command.withDescription(
    "Block until a proc is ready: a listening port (default) or an output line matching --pattern. Fails fast if it crashes instead (exit 1); exit 2 on timeout. The `restart`-then-verify step for agents and scripts.",
  ),
)

/** "3s" → for `errors` text output. */
const ago = (ts: number): string => `${describeUptime(ts)} ago`

const ERRORS_SCAN_LINES = 5000
const SAMPLE_SHOWN = 8

const errors = Command.make(
  "errors",
  {
    proc: Argument.string("proc").pipe(
      Argument.optional,
      Argument.withDescription("proc id (default: every proc)"),
    ),
    since: Flag.string("since").pipe(
      Flag.optional,
      Flag.withDescription("only output newer than this — 30s, 5m, 2h"),
    ),
    sinceMark: Flag.string("since-mark").pipe(
      Flag.optional,
      Flag.withDescription("only output after `procdeck mark <name>` was set"),
    ),
    json: jsonFlag,
  },
  ({ json, proc, since, sinceMark }) =>
    Effect.gen(function* () {
      const instance = yield* requireInstance(Option.none())
      const params = yield* logsQuery({
        proc,
        lines: ERRORS_SCAN_LINES,
        grep: Option.none(),
        since,
        sinceMark,
      })
      const result = yield* callApi(() => apiGet<LogsResult>(instance, `/logs?${params}`))
      const groups = extractErrors(result.lines)
      if (json) {
        return yield* Console.log(
          JSON.stringify({ errors: groups, scannedLines: result.lines.length }),
        )
      }
      if (groups.length === 0) {
        return yield* Console.log(
          `procdeck: no errors found in ${result.lines.length} lines${result.omitted > 0 ? " (buffer tail)" : ""}`,
        )
      }
      const render = (group: ErrorGroup): string => {
        const head = `[${group.proc}] ${group.count}× · last ${ago(group.lastTs)}${
          group.count > 1 ? ` · first ${ago(group.firstTs)}` : ""
        }`
        const sample = group.sample.slice(0, SAMPLE_SHOWN).map((line) => `  ${line}`)
        const more =
          group.sample.length > SAMPLE_SHOWN
            ? [`  … +${group.sample.length - SAMPLE_SHOWN} more lines (\`procdeck logs ${group.proc}\`)`]
            : []
        return [head, ...sample, ...more].join("\n")
      }
      yield* Console.log(groups.map(render).join("\n\n"))
    }),
).pipe(
  Command.withDescription(
    "Recent errors, parsed out of the output and deduplicated — \"same TypeError, 41×, last 3s ago\" instead of 41 stack traces. Heuristic, so `logs --grep` remains the fallback.",
  ),
)

const agents = Command.make("agents", {}, () =>
  Effect.gen(function* () {
    const configPath = yield* resolveConfig(Option.none())
    const root = path.dirname(configPath)
    const actions = setupAgents(root)
    yield* Console.log(
      ["procdeck: introducing the deck to coding agents", ...actions.map((line) => `  ${line}`)].join(
        "\n",
      ),
    )
    yield* Console.log(
      "tip:  `claude mcp add procdeck -- procdeck mcp` adds the MCP tools in every procdeck project at once",
    )
  }),
).pipe(
  Command.withDescription(
    'Introduce the deck to coding agents: a "## procdeck" section in CLAUDE.md / AGENTS.md (created if absent) and a Claude Code skill teaching the mark → act → since-mark verify loop. Idempotent.',
  ),
)

const mcp = Command.make(
  "mcp",
  {
    mutations: Flag.boolean("mutations").pipe(
      Flag.withDescription(
        "also expose restart_proc / stop_proc / start_proc (default: read-only)",
      ),
    ),
  },
  // The server owns stdout from here on: no Console.log in this branch,
  // NDJSON-RPC lives there.
  ({ mutations }) => runMcp({ version: VERSION, mutations }),
).pipe(
  Command.withDescription(
    "MCP server over stdio for coding agents: deck_status, get_logs, get_errors, set_mark, wait_for — the same verbs as the CLI. Add once, globally: `claude mcp add procdeck -- procdeck mcp`; the instance registry finds the right deck for whatever project the agent is in.",
  ),
)

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
