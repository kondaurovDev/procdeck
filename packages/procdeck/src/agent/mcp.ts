/**
 * `procdeck mcp` — the deck's tools over the Model Context Protocol (stdio).
 *
 * A thin layer over the same HTTP API the CLI verbs use: every tool is a CLI
 * verb, no new capability. What MCP adds is discoverability — the agent sees
 * the tools and their descriptions without a CLAUDE.md line — so the
 * descriptions below carry the workflow ("call deck_status first", the
 * mark → act → get_logs verify loop). Added once globally:
 *
 *     claude mcp add procdeck -- procdeck mcp
 *
 * and the instance registry resolves the right deck for whatever project the
 * agent runs in (cwd → config-walk → registry), per call — the server
 * outlives deck restarts and can start before the deck is up.
 *
 * Read-only by default; `--mutations` also exposes restart/stop/start.
 */

import * as path from "node:path"
import { Effect, Layer, Schema } from "effect"
import { McpProtocol, McpServer, Tool, Toolkit } from "effect/unstable/ai"
import * as NodeStdio from "@effect/platform-node-shared/NodeStdio"
import { apiGet, apiPost, httpParams, logsParams, statusReport, waitForProc } from "./client.ts"
import { locateConfig } from "../config.ts"
import { extractErrors } from "./errors.ts"
import type { HttpResult } from "../http-log.ts"
import type { LogsResult, Mark } from "../lines.ts"
import { findInstance } from "../registry.ts"
import type { Instance } from "../registry.ts"

/** The deck for the cwd's project — resolved per call, never cached. */
const resolveDeck = (): { instance: Instance } | { error: string } => {
  const config = locateConfig(process.cwd())
  if (config === undefined) {
    return { error: `no procdeck config found in or above ${process.cwd()}` }
  }
  const root = path.dirname(config)
  const instance = findInstance(root)
  if (instance === undefined) {
    return { error: `no deck is up for ${root} — run \`procdeck up\` there first` }
  }
  return { instance }
}

/**
 * Tool bodies never fail the MCP call: problems come back as `{error}` values
 * the agent can read and act on ("deck is down — run procdeck up").
 */
const withDeck = (run: (instance: Instance) => Promise<unknown>): Effect.Effect<unknown> =>
  Effect.promise(async () => {
    const deck = resolveDeck()
    if ("error" in deck) return deck
    try {
      return await run(deck.instance)
    } catch (cause) {
      return { error: (cause as Error).message }
    }
  })

// ---------------------------------------------------------------------------
// Tools — names and descriptions are the agent-facing documentation.
// ---------------------------------------------------------------------------

const DeckStatus = Tool.make("deck_status", {
  description:
    "Status of this project's procdeck deck (the dev-process manager): every process with state, ports, restarts and addresses, plus an `attention` list naming crashed / blocked / alerting procs with reasons. The cheapest question — call it first when anything seems broken, and before reading logs.",
  parameters: Schema.Struct({}),
  success: Schema.Unknown
})

const GetLogs = Tool.make("get_logs", {
  description:
    "Recent output of the deck's processes as plain text lines (ANSI stripped, timestamped, interleaved across procs unless `proc` narrows it). Bounded on purpose: default 200 lines, max 5000, `omitted` says how many matching lines were dropped. Narrow with `grep` (case-insensitive RegExp), `since_seconds`, `since_mark` (a mark you set), or `since_last: true` for only what arrived after your previous get_logs call in this session.",
  parameters: Schema.Struct({
    proc: Schema.optionalKey(Schema.String),
    lines: Schema.optionalKey(Schema.Number),
    grep: Schema.optionalKey(Schema.String),
    since_seconds: Schema.optionalKey(Schema.Number),
    since_mark: Schema.optionalKey(Schema.String),
    since_last: Schema.optionalKey(Schema.Boolean)
  }),
  success: Schema.Unknown
})

const GetHttp = Tool.make("get_http", {
  description:
    'HTTP traffic captured between the deck\'s processes and into them (via the *.localhost proxy and each proc\'s assigned `${port}`): method, path, status, duration and body sizes per exchange — plus WebSocket messages on the same connections (kind "ws": direction, size, text; a `connId` ties them to their status-101 upgrade). The verify loop\'s second half: set_mark → act → get_http with `since_mark` shows exactly which requests your action caused and what they returned — stronger evidence than log lines. Narrow with `status` ("5xx", "422", or "error"), `path` (RegExp), `kind` ("http" | "ws"), `since_seconds`, `since_mark`, or `since_last: true` for only what arrived after your previous get_http call. Set `bodies: true` to include captured request/response bodies and ws message text (text only, truncated; auth headers always redacted). Blind spots: outbound calls to the internet and procs on hardcoded ports.',
  parameters: Schema.Struct({
    proc: Schema.optionalKey(Schema.String),
    limit: Schema.optionalKey(Schema.Number),
    status: Schema.optionalKey(Schema.String),
    path: Schema.optionalKey(Schema.String),
    kind: Schema.optionalKey(Schema.Literals(["http", "ws"])),
    since_seconds: Schema.optionalKey(Schema.Number),
    since_mark: Schema.optionalKey(Schema.String),
    since_last: Schema.optionalKey(Schema.Boolean),
    bodies: Schema.optionalKey(Schema.Boolean)
  }),
  success: Schema.Unknown
})

const Timeline = Tool.make("timeline", {
  description:
    "Interleaved output of several processes (default: all) around a moment in time, plus the HTTP exchanges captured in the same window — \"the frontend threw a 500 at T; what were api and worker doing right then, and which requests flew?\". `at_ms` is epoch milliseconds, same clock as every log line's `ts` and get_errors' lastTs (default: now). `window_seconds` (default 10) is the half-width.",
  parameters: Schema.Struct({
    at_ms: Schema.optionalKey(Schema.Number),
    window_seconds: Schema.optionalKey(Schema.Number),
    procs: Schema.optionalKey(Schema.Array(Schema.String)),
    lines: Schema.optionalKey(Schema.Number)
  }),
  success: Schema.Unknown
})

const GetErrors = Tool.make("get_errors", {
  description:
    'Errors parsed out of recent process output and deduplicated by signature — "same TypeError, 41×, last seen 3s ago" with one sample stack trace, instead of 41 raw traces. Heuristic (JS/Python/Go-ish); fall back to get_logs with `grep` when it misses something.',
  parameters: Schema.Struct({
    proc: Schema.optionalKey(Schema.String),
    since_seconds: Schema.optionalKey(Schema.Number),
    since_mark: Schema.optionalKey(Schema.String)
  }),
  success: Schema.Unknown
})

const SetMark = Tool.make("set_mark", {
  description:
    'Drop a named marker at "now" in every process\'s output stream. The verify loop: set_mark → act (edit, restart, hit an endpoint) → get_logs/get_errors with since_mark shows only what your action caused. Marks are in-memory and die with the deck; re-marking the same name moves it.',
  parameters: Schema.Struct({
    name: Schema.optionalKey(Schema.String)
  }),
  success: Schema.Unknown
})

const WaitFor = Tool.make("wait_for", {
  description:
    "Block until a process is ready: a listening port (default) or an output line matching `pattern` (RegExp, matched against output of the current run — safe to call right after a restart). Fails fast with the last output lines if the process crashes instead of burning the timeout (default 30s). Use between restarting a process and exercising it.",
  parameters: Schema.Struct({
    proc: Schema.String,
    pattern: Schema.optionalKey(Schema.String),
    timeout_seconds: Schema.optionalKey(Schema.Number)
  }),
  success: Schema.Unknown
})

const procParam = Schema.Struct({ proc: Schema.String })

const RestartProc = Tool.make("restart_proc", {
  description:
    "Restart one process of the deck by id (stop, then start). Follow with wait_for before exercising it.",
  parameters: procParam,
  success: Schema.Unknown
})

const StopProc = Tool.make("stop_proc", {
  description: "Stop one process of the deck by id (the whole process tree).",
  parameters: procParam,
  success: Schema.Unknown
})

const StartProc = Tool.make("start_proc", {
  description: "Start one stopped process of the deck by id.",
  parameters: procParam,
  success: Schema.Unknown
})

// ---------------------------------------------------------------------------
// Handlers — each one is the matching CLI verb's body.
// ---------------------------------------------------------------------------

const ERRORS_SCAN_LINES = 5000

const logsPath = (options: {
  proc?: string | undefined
  lines: number
  grep?: string | undefined
  since_seconds?: number | undefined
  since_mark?: string | undefined
}): string =>
  `/logs?${logsParams({
    proc: options.proc,
    lines: options.lines,
    grep: options.grep,
    sinceMs:
      options.since_seconds === undefined ? undefined : Date.now() - options.since_seconds * 1000,
    mark: options.since_mark
  })}`

/**
 * "Since my last call" cursors — one stdio process is one MCP session, so
 * plain module state is exactly per-client. Every get_logs response advances
 * them (for the procs it covered); `since_last: true` reads from there.
 */
const cursors: Record<string, number> = {}
/** The same, for get_http — the two streams have independent seq spaces. */
const httpCursors: Record<string, number> = {}

const readHandlers = {
  deck_status: () => withDeck((instance) => statusReport(instance)),
  get_logs: (input: {
    proc?: string
    lines?: number
    grep?: string
    since_seconds?: number
    since_mark?: string
    since_last?: boolean
  }) =>
    withDeck(async (instance) => {
      const params = logsParams({
        proc: input.proc,
        lines: input.lines ?? 200,
        grep: input.grep,
        sinceMs:
          input.since_seconds === undefined ? undefined : Date.now() - input.since_seconds * 1000,
        mark: input.since_mark,
        sinceSeq: input.since_last === true ? cursors : undefined
      })
      const result = await apiGet<LogsResult>(instance, `/logs?${params}`)
      Object.assign(cursors, result.nextSeq)
      return result
    }),
  get_http: (input: {
    proc?: string
    limit?: number
    status?: string
    path?: string
    kind?: "http" | "ws"
    since_seconds?: number
    since_mark?: string
    since_last?: boolean
    bodies?: boolean
  }) =>
    withDeck(async (instance) => {
      const params = httpParams({
        proc: input.proc,
        limit: input.limit ?? 50,
        status: input.status,
        path: input.path,
        kind: input.kind,
        sinceMs:
          input.since_seconds === undefined ? undefined : Date.now() - input.since_seconds * 1000,
        mark: input.since_mark,
        sinceSeq: input.since_last === true ? httpCursors : undefined,
        bodies: input.bodies
      })
      const result = await apiGet<HttpResult>(instance, `/http?${params}`)
      Object.assign(httpCursors, result.nextSeq)
      return result
    }),
  timeline: (input: {
    at_ms?: number
    window_seconds?: number
    procs?: ReadonlyArray<string>
    lines?: number
  }) =>
    withDeck(async (instance) => {
      const at = input.at_ms ?? Date.now()
      const window = (input.window_seconds ?? 10) * 1000
      const proc = input.procs?.join(",")
      const params = logsParams({
        proc,
        lines: input.lines ?? 200,
        sinceMs: at - window,
        untilMs: at + window
      })
      const logs = await apiGet<LogsResult>(instance, `/logs?${params}`)
      const traffic = await apiGet<HttpResult>(
        instance,
        `/http?${httpParams({ proc, limit: 100, sinceMs: at - window, untilMs: at + window })}`
      )
      return { ...logs, http: traffic.exchanges }
    }),
  get_errors: (input: { proc?: string; since_seconds?: number; since_mark?: string }) =>
    withDeck(async (instance) => {
      const result = await apiGet<LogsResult>(
        instance,
        logsPath({ ...input, lines: ERRORS_SCAN_LINES })
      )
      return { errors: extractErrors(result.lines), scannedLines: result.lines.length }
    }),
  set_mark: (input: { name?: string }) =>
    withDeck((instance) => apiPost<Mark>(instance, "/marks", { name: input.name ?? "default" })),
  wait_for: (input: { proc: string; pattern?: string; timeout_seconds?: number }) =>
    withDeck((instance) =>
      waitForProc(instance, {
        proc: input.proc,
        pattern: input.pattern,
        timeoutMs: (input.timeout_seconds ?? 30) * 1000
      })
    )
}

const mutationHandlers = {
  restart_proc: ({ proc }: { proc: string }) =>
    withDeck((instance) => apiPost(instance, `/procs/${encodeURIComponent(proc)}/restart`, {})),
  stop_proc: ({ proc }: { proc: string }) =>
    withDeck((instance) => apiPost(instance, `/procs/${encodeURIComponent(proc)}/stop`, {})),
  start_proc: ({ proc }: { proc: string }) =>
    withDeck((instance) => apiPost(instance, `/procs/${encodeURIComponent(proc)}/start`, {}))
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const runMcp = (options: { version: string; mutations: boolean }) => {
  const transport = McpServer.layerStdio({
    name: "procdeck",
    version: options.version,
    protocols: [McpProtocol.v2025_06_18]
  }).pipe(Layer.provide(NodeStdio.layer))

  if (options.mutations) {
    const kit = Toolkit.make(
      DeckStatus,
      GetLogs,
      GetHttp,
      Timeline,
      GetErrors,
      SetMark,
      WaitFor,
      RestartProc,
      StopProc,
      StartProc
    )
    return Layer.launch(
      McpServer.toolkit(kit).pipe(
        Layer.provide(kit.toLayer({ ...readHandlers, ...mutationHandlers })),
        Layer.provideMerge(transport)
      )
    )
  }
  const kit = Toolkit.make(DeckStatus, GetLogs, GetHttp, Timeline, GetErrors, SetMark, WaitFor)
  return Layer.launch(
    McpServer.toolkit(kit).pipe(
      Layer.provide(kit.toLayer(readHandlers)),
      Layer.provideMerge(transport)
    )
  )
}
