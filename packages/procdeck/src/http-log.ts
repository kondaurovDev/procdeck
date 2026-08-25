/**
 * HTTP exchange log — the traffic twin of the line buffers (see
 * docs/design/http-observability.md). One ring per proc, byte-bounded and
 * seq-cursored like `lines.ts`, holding what flowed through procdeck's two
 * interception points: the `*.localhost` reverse proxy and the per-proc
 * observer that fronts each assigned port. Pure data structures and queries
 * here; the actual proxying lives in `interpose.ts`.
 */

/** One captured request/response pair, before proc/seq attribution. */
export type HttpCapture = {
  /** Discriminant against WsCapture; absent means "http". */
  kind?: "http" | undefined
  /** Epoch ms when the request reached the proxy. */
  ts: number
  method: string
  /** Path + query string, as the client sent it. */
  path: string
  /** Response status; 0 = the upstream never answered (connection refused). */
  status: number
  durationMs: number
  /** Full body sizes in bytes — the bodies below may be truncated. */
  reqBytes: number
  resBytes: number
  /** Text bodies, truncated to BODY_LIMIT; absent for binary or empty. */
  reqBody?: string | undefined
  resBody?: string | undefined
  /** Headers, sensitive values redacted at capture time — never stored raw. */
  reqHeaders?: Record<string, string> | undefined
  resHeaders?: Record<string, string> | undefined
  /** For 101 upgrades: ties the exchange to its WsCapture messages. */
  connId?: number | undefined
}

/** One captured WebSocket message (reassembled frames), same rings. */
export type WsCapture = {
  kind: "ws"
  /** Epoch ms when the message completed. */
  ts: number
  /** Shared with the status-101 upgrade exchange that opened the socket. */
  connId: number
  /** "in" = into the proc (client → server), "out" = out of it. */
  dir: "in" | "out"
  opcode: "text" | "binary"
  /** The upgrade request's path — so `--path` filters apply to ws too. */
  path: string
  /** Full message size in bytes; `text` below may be truncated. */
  size: number
  /** Text payload (opcode "text"), truncated like HTTP bodies. */
  text?: string | undefined
}

/** Anything a proc's ring holds. */
export type Capture = HttpCapture | WsCapture

/** An HTTP exchange in a proc's ring: attributed and cursor-addressable. */
export type HttpExchange = HttpCapture & { proc: string; seq: number }
/** A WebSocket message, attributed the same way. */
export type WsMessage = WsCapture & { proc: string; seq: number }
/** What queries return — the interleaved union. */
export type DeckCapture = HttpExchange | WsMessage

export type HttpQuery = {
  /** Proc ids to include; undefined = every proc. */
  procs?: Array<string> | undefined
  /** Per-proc: only exchanges with `seq >= sinceSeq[proc]` (a mark snapshot). */
  sinceSeq?: Record<string, number> | undefined
  sinceMs?: number | undefined
  untilMs?: number | undefined
  /** "5xx" (class), "422" (exact), or "error" (>=400 and never-answered).
   * WebSocket messages have no status, so any status filter excludes them. */
  status?: string | undefined
  /** RegExp source matched against the path (case-insensitive). */
  path?: string | undefined
  /** Only this kind of capture; undefined = both, interleaved. */
  captureKind?: "http" | "ws" | undefined
  /** Include bodies and headers in the result (off = metadata only). */
  bodies?: boolean | undefined
  /** Max exchanges returned — the *tail* of the matches. */
  limit: number
}

export type HttpResult = {
  exchanges: Array<DeckCapture>
  /** Per requested proc: the seq the next capture will get — a resume cursor. */
  nextSeq: Record<string, number>
  /** Matching captures dropped by `limit` (the oldest ones). */
  omitted: number
}

/** Per-body capture cap; the full size is always recorded in req/resBytes. */
export const BODY_LIMIT = 16 * 1024
/** Byte budget per proc's ring — bodies make exchanges fat, so 2× lines.ts. */
const BUFFER_BYTES = 512 * 1024

/**
 * Accumulates a body stream: counts every byte, keeps at most BODY_LIMIT of
 * them, and only when the content-type said "text" — binary bodies are a
 * fact and a size, never bytes.
 */
export class BodyTap {
  bytes = 0
  private chunks: Array<Buffer> = []
  private budget = BODY_LIMIT
  private readonly text: boolean

  // No parameter properties: src runs directly under node's type stripping.
  constructor(text: boolean) {
    this.text = text
  }

  push(chunk: Buffer | string): void {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    this.bytes += buffer.length
    if (!this.text || this.budget <= 0) return
    const take = buffer.subarray(0, this.budget)
    this.chunks.push(take)
    this.budget -= take.length
  }

  get body(): string | undefined {
    if (!this.text || this.bytes === 0) return undefined
    return Buffer.concat(this.chunks).toString("utf8")
  }
}

/** Content types whose bodies are worth keeping as text. */
export const isTextType = (contentType: string | undefined): boolean => {
  if (contentType === undefined) return false
  const bare = contentType.split(";")[0]!.trim().toLowerCase()
  return (
    bare.startsWith("text/") ||
    bare === "application/json" ||
    bare === "application/x-www-form-urlencoded" ||
    bare === "application/xml" ||
    bare === "application/graphql" ||
    bare === "application/javascript" ||
    bare.endsWith("+json") ||
    bare.endsWith("+xml")
  )
}

/** Header names whose values never enter the ring. */
const SENSITIVE = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token"
])

/** Lowercased headers with sensitive values replaced — applied at capture. */
export const redactHeaders = (
  headers: Record<string, string | Array<string> | number | undefined>
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const key = name.toLowerCase()
    out[key] = SENSITIVE.has(key)
      ? "[redacted]"
      : Array.isArray(value)
        ? value.join(", ")
        : String(value)
  }
  return out
}

/** Byte-bounded, seq-cursored ring of one proc's captures. */
export class HttpBuffer {
  private items: Array<Capture & { seq: number }> = []
  private bytes = 0
  private seq = 0

  /** The seq the next recorded capture will get. */
  get nextSeq(): number {
    return this.seq
  }

  record(capture: Capture): void {
    const item = { ...capture, seq: this.seq++ }
    this.items.push(item)
    this.bytes += cost(item)
    while (this.bytes > BUFFER_BYTES && this.items.length > 1) {
      this.bytes -= cost(this.items.shift()!)
    }
  }

  slice(
    options: {
      sinceSeq?: number | undefined
      sinceMs?: number | undefined
      untilMs?: number | undefined
    } = {}
  ): Array<Capture & { seq: number }> {
    const { sinceMs, sinceSeq, untilMs } = options
    return this.items.filter(
      (item) =>
        (sinceSeq === undefined || item.seq >= sinceSeq) &&
        (sinceMs === undefined || item.ts >= sinceMs) &&
        (untilMs === undefined || item.ts <= untilMs)
    )
  }
}

/** Approximate memory footprint of one capture, for the ring's byte budget. */
const cost = (capture: Capture): number =>
  capture.kind === "ws"
    ? 64 + capture.path.length + (capture.text?.length ?? 0)
    : 64 +
      capture.path.length +
      (capture.reqBody?.length ?? 0) +
      (capture.resBody?.length ?? 0) +
      (capture.reqHeaders === undefined ? 0 : JSON.stringify(capture.reqHeaders).length) +
      (capture.resHeaders === undefined ? 0 : JSON.stringify(capture.resHeaders).length)

/** "5xx" / "404" / "error" → a status predicate; undefined = unparsable. */
export const statusMatcher = (raw: string): ((status: number) => boolean) | undefined => {
  const cls = /^([1-5])xx$/i.exec(raw)
  if (cls !== null) {
    const base = Number(cls[1]) * 100
    return (status) => status >= base && status < base + 100
  }
  if (/^\d{3}$/.test(raw)) {
    const code = Number(raw)
    return (status) => status === code
  }
  if (raw === "error" || raw === "errors") return (status) => status >= 400 || status === 0
  return undefined
}

const withoutBodies = (capture: DeckCapture): DeckCapture => {
  if (capture.kind === "ws") {
    const { text: _t, ...rest } = capture
    return rest
  }
  const { reqBody: _rq, reqHeaders: _rh, resBody: _sb, resHeaders: _sh, ...rest } = capture
  return rest
}

/**
 * One query over many procs' rings: filter, interleave by time, keep the
 * tail. Throws on an unknown proc, a bad path pattern or a bad status filter
 * — callers turn that into a 400 / a CLI failure.
 */
export const queryHttp = (buffers: Map<string, HttpBuffer>, query: HttpQuery): HttpResult => {
  const ids = query.procs ?? [...buffers.keys()]
  const pathPattern = query.path === undefined ? undefined : new RegExp(query.path, "i")
  const matchStatus = query.status === undefined ? undefined : statusMatcher(query.status)
  if (query.status !== undefined && matchStatus === undefined) {
    throw new Error(`bad status filter "${query.status}" — try 5xx, 422 or error`)
  }

  const matched: Array<DeckCapture> = []
  const nextSeq: Record<string, number> = {}
  for (const id of ids) {
    const buffer = buffers.get(id)
    if (buffer === undefined) throw new Error(`unknown proc "${id}"`)
    nextSeq[id] = buffer.nextSeq
    for (const item of buffer.slice({
      sinceSeq: query.sinceSeq?.[id],
      sinceMs: query.sinceMs,
      untilMs: query.untilMs
    })) {
      const itemKind = item.kind === "ws" ? "ws" : "http"
      if (query.captureKind !== undefined && itemKind !== query.captureKind) continue
      if (pathPattern !== undefined && !pathPattern.test(item.path)) continue
      // A status filter names response codes — ws messages have none.
      if (matchStatus !== undefined && (item.kind === "ws" || !matchStatus(item.status))) continue
      matched.push({ ...item, proc: id })
    }
  }

  matched.sort((a, b) => a.ts - b.ts || a.proc.localeCompare(b.proc) || a.seq - b.seq)
  const omitted = Math.max(0, matched.length - query.limit)
  const tail = matched.slice(omitted)
  return {
    exchanges: query.bodies === true ? tail : tail.map(withoutBodies),
    nextSeq,
    omitted
  }
}

/**
 * Collapse path params so exchanges group by route: numeric, uuid and hex-ish
 * segments become `:id` — the same spirit as error signatures. The query
 * string is dropped entirely.
 */
export const normalizePath = (path: string): string => {
  const bare = path.split("?")[0]!
  return bare
    .split("/")
    .map((segment) =>
      /^\d+$/.test(segment) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
      /^[0-9a-f]{8,}$/i.test(segment)
        ? ":id"
        : segment
    )
    .join("/")
}

export type HttpDigestGroup = {
  proc: string
  method: string
  /** Normalized route — `/users/:id`, not `/users/42`. */
  path: string
  status: number
  count: number
  firstTs: number
  lastTs: number
}

/**
 * The `errors` analog for traffic: 4xx/5xx (and never-answered) exchanges
 * grouped by proc + method + normalized route + status, most recent first.
 */
export const digestHttp = (exchanges: Array<DeckCapture>): Array<HttpDigestGroup> => {
  const groups = new Map<string, HttpDigestGroup>()
  for (const exchange of exchanges) {
    if (exchange.kind === "ws") continue // messages have no failure status
    if (exchange.status < 400 && exchange.status !== 0) continue
    const route = normalizePath(exchange.path)
    const key = `${exchange.proc}\u0000${exchange.method}\u0000${route}\u0000${exchange.status}`
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, {
        proc: exchange.proc,
        method: exchange.method,
        path: route,
        status: exchange.status,
        count: 1,
        firstTs: exchange.ts,
        lastTs: exchange.ts
      })
    } else {
      group.count += 1
      group.firstTs = Math.min(group.firstTs, exchange.ts)
      group.lastTs = Math.max(group.lastTs, exchange.ts)
    }
  }
  return [...groups.values()].sort((a, b) => b.lastTs - a.lastTs)
}
