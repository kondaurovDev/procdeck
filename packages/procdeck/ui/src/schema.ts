import { Schema as S } from "effect"

/**
 * Wire schemas for the procdeck API. They mirror the server's TypeScript types
 * in src/events.ts — here they are Schemas because everything crossing the
 * network boundary gets decoded, and because the Model is itself a Schema.
 */

export const ProcState = S.Literals(["stopped", "waiting", "starting", "running", "exited", "blocked"])
export type ProcState = typeof ProcState.Type

export const ProcStatus = S.Struct({
  id: S.String,
  state: ProcState,
  pid: S.optionalKey(S.Number),
  exitCode: S.optionalKey(S.Number),
  signal: S.optionalKey(S.Number),
  startedAt: S.optionalKey(S.Number),
  ports: S.optionalKey(S.Array(S.Number)),
  hint: S.optionalKey(S.String),
  alert: S.optionalKey(S.String),
})
export type ProcStatus = typeof ProcStatus.Type

export const ProcInfo = S.Struct({
  id: S.String,
  command: S.String,
  url: S.optionalKey(S.String),
  assignedPort: S.optionalKey(S.Number),
  proxyUrl: S.optionalKey(S.String),
  status: ProcStatus,
})
export type ProcInfo = typeof ProcInfo.Type

export const ProcEvent = S.Union([
  S.Struct({ type: S.Literal("log"), id: S.String, data: S.String }),
  S.Struct({ type: S.Literal("status"), status: ProcStatus }),
])
export type ProcEvent = typeof ProcEvent.Type

/** The deck as a whole (`GET /deck`). */
export const DeckInfo = S.Struct({ name: S.String })
export type DeckInfo = typeof DeckInfo.Type

export const API = "/__procdeck/api"
