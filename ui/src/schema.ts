import { Schema as S } from "effect"

/**
 * Wire schemas for the procdeck API. They mirror the server's TypeScript types
 * in src/events.ts — here they are Schemas because everything crossing the
 * network boundary gets decoded, and because the Model is itself a Schema.
 */

export const ProcState = S.Literals([
  "stopped",
  "waiting",
  "starting",
  "running",
  "exited",
  "blocked"
])
export type ProcState = typeof ProcState.Type

export const ProcStatus = S.Struct({
  id: S.String,
  state: ProcState,
  pid: S.optionalKey(S.Number),
  exitCode: S.optionalKey(S.Number),
  signal: S.optionalKey(S.String),
  startedAt: S.optionalKey(S.Number),
  exitedAt: S.optionalKey(S.Number),
  restarts: S.optionalKey(S.Number),
  ports: S.optionalKey(S.Array(S.Number)),
  hint: S.optionalKey(S.String),
  alert: S.optionalKey(S.String)
})
export type ProcStatus = typeof ProcStatus.Type

export const ProcInfo = S.Struct({
  id: S.String,
  command: S.String,
  url: S.optionalKey(S.String),
  assignedPort: S.optionalKey(S.Number),
  proxyUrl: S.optionalKey(S.String),
  status: ProcStatus
})
export type ProcInfo = typeof ProcInfo.Type

/**
 * A (re)connected feed delivers each proc's backlog (chunks, then its status),
 * then `synced`, then live events — so "history" vs "news" is explicit.
 */
export const ProcEvent = S.Union([
  S.Struct({ type: S.Literal("log"), id: S.String, data: S.String, seq: S.optionalKey(S.Number) }),
  S.Struct({ type: S.Literal("status"), status: ProcStatus }),
  S.Struct({ type: S.Literal("synced") })
])
export type ProcEvent = typeof ProcEvent.Type

/** The deck as a whole (`GET /deck`). */
export const DeckInfo = S.Struct({
  name: S.String,
  /** Project root — shown in the shutdown banner ("procdeck up in …"). */
  root: S.optionalKey(S.String),
  port: S.optionalKey(S.Number),
  version: S.optionalKey(S.String)
})
export type DeckInfo = typeof DeckInfo.Type

/** One running deck on this machine (`GET /instances`), for the deck switcher. */
export const InstanceInfo = S.Struct({
  name: S.String,
  root: S.String,
  port: S.Number,
  startedAt: S.Number,
  version: S.optionalKey(S.String),
  self: S.Boolean
})
export type InstanceInfo = typeof InstanceInfo.Type

/**
 * One captured entry from `GET /http` — an HTTP exchange, or (kind "ws") a
 * WebSocket message. One loose struct instead of a union: the two shapes
 * share proc/seq/ts/path, and optionalKey keeps the rest honest.
 */
export const TrafficEntry = S.Struct({
  proc: S.String,
  seq: S.Number,
  ts: S.Number,
  kind: S.optionalKey(S.Literals(["http", "ws"])),
  path: S.String,
  // HTTP exchange fields
  method: S.optionalKey(S.String),
  status: S.optionalKey(S.Number),
  durationMs: S.optionalKey(S.Number),
  reqBytes: S.optionalKey(S.Number),
  resBytes: S.optionalKey(S.Number),
  reqBody: S.optionalKey(S.String),
  resBody: S.optionalKey(S.String),
  reqHeaders: S.optionalKey(S.Record(S.String, S.String)),
  resHeaders: S.optionalKey(S.Record(S.String, S.String)),
  connId: S.optionalKey(S.Number),
  // WebSocket message fields
  dir: S.optionalKey(S.Literals(["in", "out"])),
  opcode: S.optionalKey(S.String),
  size: S.optionalKey(S.Number),
  text: S.optionalKey(S.String)
})
export type TrafficEntry = typeof TrafficEntry.Type

/** The `GET /http` answer. */
export const TrafficResult = S.Struct({
  exchanges: S.Array(TrafficEntry),
  nextSeq: S.Record(S.String, S.Number),
  omitted: S.Number
})
export type TrafficResult = typeof TrafficResult.Type

export const API = "/__procdeck/api"
