import { Schema as S } from "effect"
import { m } from "foldkit/message"
import { ProcInfo, ProcStatus } from "./schema.ts"

// Server data arriving
export const GotProcs = m("GotProcs", { procs: S.Array(ProcInfo) })
export const FailedFetchProcs = m("FailedFetchProcs", { error: S.String })
export const ReceivedStatus = m("ReceivedStatus", { status: ProcStatus })
export const ReceivedLog = m("ReceivedLog", { id: S.String, data: S.String })

// Terminal lifecycle and input
export const MountedTerminal = m("MountedTerminal", { id: S.String })
export const TypedInput = m("TypedInput", { id: S.String, data: S.String })

// User intent
export const ClickedProc = m("ClickedProc", { id: S.String })
export const ClickedStart = m("ClickedStart")
export const ClickedStop = m("ClickedStop")
export const ClickedRestart = m("ClickedRestart")
export const ResizedWindow = m("ResizedWindow")

// Uptime clock — fires once a second while anything is running
export const Ticked = m("Ticked", { now: S.Number })

// Fire-and-forget Command acknowledgements (update no-ops on it; keeps the
// side effect visible to DevTools and tests)
export const CompletedRequest = m("CompletedRequest")

export const Message = S.Union([
  GotProcs,
  FailedFetchProcs,
  ReceivedStatus,
  ReceivedLog,
  MountedTerminal,
  TypedInput,
  ClickedProc,
  ClickedStart,
  ClickedStop,
  ClickedRestart,
  ResizedWindow,
  Ticked,
  CompletedRequest,
])
export type Message = typeof Message.Type
