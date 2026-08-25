/**
 * The agent-facing commands — the CLI face of the agent harness (see
 * docs/agent-harness.md): logs, mark, wait-for, errors, agents, mcp.
 * Deck lifecycle commands (up/down/restart/status/…) live in cli.ts.
 */

import { existsSync, readFileSync, statSync, unwatchFile, watchFile } from "node:fs"
import * as path from "node:path"
import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { apiGet, apiPost, logsParams, waitForProc } from "../agent/client.ts"
import { setupAgents } from "../agent/discover.ts"
import { extractErrors } from "../agent/errors.ts"
import type { ErrorGroup } from "../agent/errors.ts"
import { runMcp } from "../agent/mcp.ts"
import type { LogsResult, Mark } from "../lines.ts"
import { pretty } from "../lifecycle.ts"
import { logPath } from "../registry.ts"
import { VERSION } from "../version.ts"
import {
  callApi,
  describeUptime,
  fail,
  jsonFlag,
  parseDuration,
  requireInstance,
  resolveConfig,
  resolveRoot
} from "./shared.ts"

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
      (onChange) => Effect.sync(() => unwatchFile(file, onChange))
    )
    return yield* Effect.never
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
      mark: Option.getOrUndefined(options.sinceMark)
    })
  })

export const logs = Command.make(
  "logs",
  {
    proc: Argument.string("proc").pipe(
      Argument.optional,
      Argument.withDescription("proc id (default: every proc, interleaved with [id] prefixes)")
    ),
    lines: Flag.integer("lines").pipe(
      Flag.withAlias("n"),
      Flag.withDefault(200),
      Flag.withDescription("max lines — the most recent ones (default 200, max 5000)")
    ),
    grep: Flag.string("grep").pipe(
      Flag.optional,
      Flag.withDescription("only lines matching this RegExp (case-insensitive)")
    ),
    since: Flag.string("since").pipe(
      Flag.optional,
      Flag.withDescription("only lines newer than this — 30s, 5m, 2h")
    ),
    sinceMark: Flag.string("since-mark").pipe(
      Flag.optional,
      Flag.withDescription("only lines after `procdeck mark <name>` was set")
    ),
    json: jsonFlag,
    self: Flag.boolean("self").pipe(
      Flag.withDescription("procdeck's own daemon log instead of pane output")
    ),
    follow: Flag.boolean("follow").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("keep printing new lines (with --self only, for now)")
    )
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
        result.lines.map((line) => (multi ? `[${line.proc}] ${line.text}` : line.text)).join("\n")
      )
    })
).pipe(
  Command.withDescription(
    "Recent output of the deck's processes: plain lines, filterable and bounded — made for agents as much as for humans. `--self` is procdeck's own daemon log."
  )
)

export const mark = Command.make(
  "mark",
  {
    name: Argument.string("name").pipe(
      Argument.withDefault("default"),
      Argument.withDescription('mark name (default "default") — names keep two agents apart')
    ),
    json: jsonFlag
  },
  ({ json, name }) =>
    Effect.gen(function* () {
      const instance = yield* requireInstance(Option.none())
      const result = yield* callApi(() => apiPost<Mark>(instance, "/marks", { name }))
      if (json) return yield* Console.log(JSON.stringify(result))
      yield* Console.log(
        `procdeck: mark "${result.name}" set — read what happens next with \`procdeck logs --since-mark ${result.name}\``
      )
    })
).pipe(
  Command.withDescription(
    'Drop a named marker at "now" in every proc\'s output. The verify loop: mark → act (restart, hit an endpoint) → `logs --since-mark` shows only what your action caused.'
  )
)

export const waitFor = Command.make(
  "wait-for",
  {
    proc: Argument.string("proc").pipe(Argument.withDescription("proc id to wait for")),
    pattern: Flag.string("pattern").pipe(
      Flag.optional,
      Flag.withDescription(
        "succeed when this RegExp matches a new output line (default: wait for a listening port)"
      )
    ),
    timeout: Flag.string("timeout").pipe(
      Flag.withDefault("30s"),
      Flag.withDescription("give up after this long (exit code 2)")
    )
  },
  ({ pattern, proc, timeout }) =>
    Effect.gen(function* () {
      const instance = yield* requireInstance(Option.none())
      const timeoutMs = parseDuration(timeout)
      if (timeoutMs === undefined) {
        return yield* fail(`bad --timeout "${timeout}" — try 30s, 5m`)
      }
      const outcome = yield* callApi(() =>
        waitForProc(instance, { proc, pattern: Option.getOrUndefined(pattern), timeoutMs })
      )
      if (outcome.ok) return yield* Console.log(`procdeck: ${outcome.message}`)
      if (outcome.tail.length > 0) {
        yield* Console.error(outcome.tail.map((line) => `  ${line}`).join("\n"))
      }
      return yield* fail(
        outcome.kind === "crashed" ? `${outcome.reason} — last lines above` : outcome.reason,
        outcome.kind === "timeout" ? 2 : 1
      )
    })
).pipe(
  Command.withDescription(
    "Block until a proc is ready: a listening port (default) or an output line matching --pattern. Fails fast if it crashes instead (exit 1); exit 2 on timeout. The `restart`-then-verify step for agents and scripts."
  )
)

/** "3s" → for `errors` text output. */
const ago = (ts: number): string => `${describeUptime(ts)} ago`

const ERRORS_SCAN_LINES = 5000
const SAMPLE_SHOWN = 8

export const errors = Command.make(
  "errors",
  {
    proc: Argument.string("proc").pipe(
      Argument.optional,
      Argument.withDescription("proc id (default: every proc)")
    ),
    since: Flag.string("since").pipe(
      Flag.optional,
      Flag.withDescription("only output newer than this — 30s, 5m, 2h")
    ),
    sinceMark: Flag.string("since-mark").pipe(
      Flag.optional,
      Flag.withDescription("only output after `procdeck mark <name>` was set")
    ),
    json: jsonFlag
  },
  ({ json, proc, since, sinceMark }) =>
    Effect.gen(function* () {
      const instance = yield* requireInstance(Option.none())
      const params = yield* logsQuery({
        proc,
        lines: ERRORS_SCAN_LINES,
        grep: Option.none(),
        since,
        sinceMark
      })
      const result = yield* callApi(() => apiGet<LogsResult>(instance, `/logs?${params}`))
      const groups = extractErrors(result.lines)
      if (json) {
        return yield* Console.log(
          JSON.stringify({ errors: groups, scannedLines: result.lines.length })
        )
      }
      if (groups.length === 0) {
        return yield* Console.log(
          `procdeck: no errors found in ${result.lines.length} lines${result.omitted > 0 ? " (buffer tail)" : ""}`
        )
      }
      const render = (group: ErrorGroup): string => {
        const head = `[${group.proc}] ${group.count}× · last ${ago(group.lastTs)}${
          group.count > 1 ? ` · first ${ago(group.firstTs)}` : ""
        }`
        const sample = group.sample.slice(0, SAMPLE_SHOWN).map((line) => `  ${line}`)
        const more =
          group.sample.length > SAMPLE_SHOWN
            ? [
                `  … +${group.sample.length - SAMPLE_SHOWN} more lines (\`procdeck logs ${group.proc}\`)`
              ]
            : []
        return [head, ...sample, ...more].join("\n")
      }
      yield* Console.log(groups.map(render).join("\n\n"))
    })
).pipe(
  Command.withDescription(
    'Recent errors, parsed out of the output and deduplicated — "same TypeError, 41×, last 3s ago" instead of 41 stack traces. Heuristic, so `logs --grep` remains the fallback.'
  )
)

export const agents = Command.make("agents", {}, () =>
  Effect.gen(function* () {
    const configPath = yield* resolveConfig(Option.none())
    const root = path.dirname(configPath)
    const actions = setupAgents(root)
    yield* Console.log(
      [
        "procdeck: introducing the deck to coding agents",
        ...actions.map((line) => `  ${line}`)
      ].join("\n")
    )
    yield* Console.log(
      "tip:  `claude mcp add procdeck -- procdeck mcp` adds the MCP tools in every procdeck project at once"
    )
  })
).pipe(
  Command.withDescription(
    'Introduce the deck to coding agents: a "## procdeck" section in CLAUDE.md / AGENTS.md (created if absent) and a Claude Code skill teaching the mark → act → since-mark verify loop. Idempotent.'
  )
)

export const mcp = Command.make(
  "mcp",
  {
    mutations: Flag.boolean("mutations").pipe(
      Flag.withDescription("also expose restart_proc / stop_proc / start_proc (default: read-only)")
    )
  },
  // The server owns stdout from here on: no Console.log in this branch,
  // NDJSON-RPC lives there.
  ({ mutations }) => runMcp({ version: VERSION, mutations })
).pipe(
  Command.withDescription(
    "MCP server over stdio for coding agents: deck_status, get_logs, get_http, get_errors, set_mark, wait_for — the same verbs as the CLI. Add once, globally: `claude mcp add procdeck -- procdeck mcp`; the instance registry finds the right deck for whatever project the agent is in."
  )
)
