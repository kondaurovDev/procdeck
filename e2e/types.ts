/**
 * The wire shapes of `GET /http` and `procdeck http --json` that the suites
 * read — an HTTP exchange has no `kind` key, a WebSocket message has
 * `kind: "ws"`.
 */
export type HttpExchange = {
  kind?: undefined
  ts: number
  method: string
  path: string
  status: number
  durationMs: number
  reqBytes: number
  resBytes: number
  reqBody?: string
  resBody?: string
  reqHeaders?: Record<string, string>
  resHeaders?: Record<string, string>
  connId?: number
  proc: string
  seq: number
}

export type WsMessage = {
  kind: "ws"
  ts: number
  connId: number
  dir: "in" | "out"
  opcode: "text" | "binary"
  path: string
  size: number
  text?: string
  proc: string
  seq: number
}

export type DeckCapture = HttpExchange | WsMessage

export type HttpResult = {
  exchanges: Array<DeckCapture>
  nextSeq: Record<string, number>
  omitted: number
}

export type HttpDigestGroup = {
  proc: string
  method: string
  path: string
  status: number
  count: number
  firstTs: number
  lastTs: number
}
