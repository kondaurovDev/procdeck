/**
 * Deck API client — promise-based helpers over a running deck's HTTP API,
 * shared by the CLI commands and the MCP server. One implementation of
 * "ask the deck", two front doors.
 */

import type { ProcInfo } from "../events.ts"
import type { LogsResult } from "../lines.ts"
import type { Instance } from "../registry.ts"

export const deckUrl = (instance: Instance): string => `http://localhost:${instance.port}`

/** GET against the deck's API; a 4xx `{error}` body becomes the Error message. */
export const apiGet = async <T>(instance: Instance, pathname: string): Promise<T> => {
  const response = await fetch(`${deckUrl(instance)}/__procdeck/api${pathname}`, {
    signal: AbortSignal.timeout(5000),
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(
      (body as { error?: string } | null)?.error ?? `deck answered HTTP ${response.status}`,
    )
  }
  return body as T
}

export const apiPost = async <T>(
  instance: Instance,
  pathname: string,
  body: unknown,
): Promise<T> => {
  const response = await fetch(`${deckUrl(instance)}/__procdeck/api${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
  const answer: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(
      (answer as { error?: string } | null)?.error ?? `deck answered HTTP ${response.status}`,
    )
  }
  return answer as T
}

/** The deck's procs; `undefined` when the deck does not answer. */
export const fetchProcs = async (instance: Instance): Promise<Array<ProcInfo> | undefined> => {
  try {
    return await apiGet<Array<ProcInfo>>(instance, "/procs")
  } catch {
    return undefined
  }
}

export const describeProc = (info: ProcInfo): string => {
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

/** Why this proc deserves a look, if it does — the CLI/MCP twin of the UI badge. */
export const attentionOf = (info: ProcInfo): string | undefined => {
  const status = info.status
  if (status.state === "blocked") {
    return status.hint === undefined ? "blocked" : `blocked — ${status.hint}`
  }
  if (status.alert !== undefined) return `alert: ${status.alert}`
  if (status.state === "exited" && (status.signal !== undefined || (status.exitCode ?? 0) !== 0)) {
    return describeProc(info)
  }
  return undefined
}

/** `status --json` / the `deck_status` MCP tool — the agent's first question. */
export type StatusReport = {
  up: true
  name: string
  root: string
  url: string
  pid: number
  version: string
  mode: Instance["mode"]
  startedAt: number
  /** Procs that deserve a look right now — crashed, blocked, alerting. */
  attention: Array<{ id: string; reason: string }>
  procs: Array<ProcInfo> | null
}

export const statusReport = async (instance: Instance): Promise<StatusReport> => {
  const procs = await fetchProcs(instance)
  const attention = (procs ?? []).flatMap((info) => {
    const reason = attentionOf(info)
    return reason === undefined ? [] : [{ id: info.id, reason }]
  })
  return {
    up: true,
    name: instance.name,
    root: instance.root,
    url: deckUrl(instance),
    pid: instance.pid,
    version: instance.version,
    mode: instance.mode,
    startedAt: instance.startedAt,
    attention,
    procs: procs ?? null,
  }
}

/** Query-string builder for `GET /logs` — one spelling of the parameters. */
export const logsParams = (options: {
  /** Proc id, or several as csv. */
  proc?: string | undefined
  lines: number
  grep?: string | undefined
  sinceMs?: number | undefined
  untilMs?: number | undefined
  mark?: string | undefined
  /** Per-proc resume cursors (a previous response's `nextSeq`). */
  sinceSeq?: Record<string, number> | undefined
}): URLSearchParams => {
  const params = new URLSearchParams()
  if (options.proc !== undefined) params.set("procs", options.proc)
  params.set("lines", String(options.lines))
  if (options.grep !== undefined) params.set("grep", options.grep)
  if (options.sinceMs !== undefined) params.set("sinceMs", String(options.sinceMs))
  if (options.untilMs !== undefined) params.set("untilMs", String(options.untilMs))
  if (options.mark !== undefined) params.set("mark", options.mark)
  if (options.sinceSeq !== undefined && Object.keys(options.sinceSeq).length > 0) {
    params.set("sinceSeq", JSON.stringify(options.sinceSeq))
  }
  return params
}

/** Query-string builder for `GET /http` — one spelling of the parameters. */
export const httpParams = (options: {
  /** Proc id, or several as csv. */
  proc?: string | undefined
  limit: number
  /** "5xx" / "422" / "error". */
  status?: string | undefined
  /** RegExp source matched against the path. */
  path?: string | undefined
  sinceMs?: number | undefined
  untilMs?: number | undefined
  mark?: string | undefined
  /** Per-proc resume cursors (a previous response's `nextSeq`). */
  sinceSeq?: Record<string, number> | undefined
  /** Only this kind of capture; undefined = both. */
  kind?: "http" | "ws" | undefined
  /** Include captured bodies and headers (and ws message text). */
  bodies?: boolean | undefined
}): URLSearchParams => {
  const params = new URLSearchParams()
  if (options.proc !== undefined) params.set("procs", options.proc)
  params.set("limit", String(options.limit))
  if (options.status !== undefined) params.set("status", options.status)
  if (options.path !== undefined) params.set("path", options.path)
  if (options.sinceMs !== undefined) params.set("sinceMs", String(options.sinceMs))
  if (options.untilMs !== undefined) params.set("untilMs", String(options.untilMs))
  if (options.mark !== undefined) params.set("mark", options.mark)
  if (options.sinceSeq !== undefined && Object.keys(options.sinceSeq).length > 0) {
    params.set("sinceSeq", JSON.stringify(options.sinceSeq))
  }
  if (options.kind !== undefined) params.set("kind", options.kind)
  if (options.bodies === true) params.set("bodies", "1")
  return params
}

export type WaitOutcome =
  | { ok: true; message: string; elapsedSeconds: number }
  | {
      ok: false
      kind: "crashed" | "blocked" | "stopped" | "timeout"
      reason: string
      /** Last output lines when the proc crashed — the "why", right there. */
      tail: Array<string>
    }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Block until a proc is ready: a listening port (default) or an output line
 * matching `pattern`. Fails fast when the proc crashes or is blocked instead
 * of burning the timeout. Pattern searches start at the current *run's* first
 * line, so `restart` + `wait-for` cannot lose a line that lands in between;
 * after the first poll a seq cursor takes over.
 */
export const waitForProc = async (
  instance: Instance,
  options: {
    proc: string
    pattern?: string | undefined
    timeoutMs: number
    pollMs?: number | undefined
  },
): Promise<WaitOutcome> => {
  const { pattern, proc, timeoutMs } = options
  const pollMs = options.pollMs ?? 300
  const started = Date.now()
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`
  const elapsedSeconds = () => (Date.now() - started) / 1000
  let cursor: number | undefined
  let stoppedPolls = 0

  while (true) {
    const procs = await apiGet<Array<ProcInfo>>(instance, "/procs")
    const info = procs.find((candidate) => candidate.id === proc)
    if (info === undefined) throw new Error(`unknown proc "${proc}"`)
    const status = info.status

    if (status.state === "exited") {
      const tail = await apiGet<LogsResult>(
        instance,
        `/logs?procs=${encodeURIComponent(proc)}&lines=20`,
      )
      return {
        ok: false,
        kind: "crashed",
        reason: `"${proc}" ${describeProc(info)} after ${elapsed()}`,
        tail: tail.lines.map((line) => line.text),
      }
    }
    if (status.state === "blocked") {
      return {
        ok: false,
        kind: "blocked",
        reason: `"${proc}" is blocked${status.hint === undefined ? "" : ` — ${status.hint}`}`,
        tail: [],
      }
    }
    // A brief "stopped" can be the middle of a restart; a persistent one
    // means nobody is starting it — fail rather than burn the timeout.
    stoppedPolls = status.state === "stopped" ? stoppedPolls + 1 : 0
    if (stoppedPolls >= 4) {
      return {
        ok: false,
        kind: "stopped",
        reason: `"${proc}" is stopped and nothing is starting it`,
        tail: [],
      }
    }

    if (pattern !== undefined) {
      const params = new URLSearchParams()
      params.set("procs", proc)
      params.set("grep", pattern)
      params.set("lines", "5")
      if (cursor !== undefined) params.set("sinceSeq", String(cursor))
      else if (status.startedAt !== undefined) params.set("sinceMs", String(status.startedAt))
      else params.set("sinceMs", String(started))
      const result = await apiGet<LogsResult>(instance, `/logs?${params}`)
      if (result.lines.length > 0) {
        return {
          ok: true,
          message: `"${proc}" matched /${pattern}/ in ${elapsed()}: ${result.lines[0]!.text}`,
          elapsedSeconds: elapsedSeconds(),
        }
      }
      cursor = result.nextSeq[proc] ?? cursor
    } else {
      const ports = status.ports ?? []
      if (ports.length > 0) {
        return {
          ok: true,
          message: `"${proc}" is listening on :${ports[0]} (${elapsed()})`,
          elapsedSeconds: elapsedSeconds(),
        }
      }
    }

    if (Date.now() - started >= timeoutMs) {
      return {
        ok: false,
        kind: "timeout",
        reason: `timed out after ${Math.round(timeoutMs / 1000)}s waiting for "${proc}" to ${
          pattern === undefined ? "listen on a port" : `match /${pattern}/`
        }`,
        tail: [],
      }
    }
    await sleep(pollMs)
  }
}
