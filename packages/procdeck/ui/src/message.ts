import { Schema as S } from "effect"
import { m } from "foldkit/message"
import { ProcInfo, ProcStatus } from "./schema.ts"

// Server data arriving
export const GotProcs = m("GotProcs", { procs: S.Array(ProcInfo) })
export const FailedFetchProcs = m("FailedFetchProcs", { error: S.String })
export const ReceivedStatus = m("ReceivedStatus", { status: ProcStatus })
/**
 * `live` is false for chunks replayed from the server's ring buffer right
 * after (re)connect — those land in the terminal but must not count as unread.
 */
export const ReceivedLog = m("ReceivedLog", { id: S.String, data: S.String, live: S.Boolean })

// Terminal lifecycle and input
export const MountedTerminal = m("MountedTerminal", { id: S.String })
export const TypedInput = m("TypedInput", { id: S.String, data: S.String })

// User intent
export const ClickedProc = m("ClickedProc", { id: S.String })
export const ClickedStart = m("ClickedStart")
export const ClickedStop = m("ClickedStop")
export const ClickedRestart = m("ClickedRestart")
export const ClickedClear = m("ClickedClear")
export const ResizedWindow = m("ResizedWindow")

// Hotkeys (the button-shaped intents above double as hotkey targets)
export const SelectedProcOffset = m("SelectedProcOffset", { delta: S.Number })
/** Stop the active proc if it is busy, start it if it is idle. */
export const PressedToggle = m("PressedToggle")

// Log search
export const OpenedSearch = m("OpenedSearch")
export const ChangedSearch = m("ChangedSearch", { query: S.String })
export const SteppedSearch = m("SteppedSearch", { backwards: S.Boolean })
export const ClosedSearch = m("ClosedSearch")

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
  ClickedClear,
  ResizedWindow,
  SelectedProcOffset,
  PressedToggle,
  OpenedSearch,
  ChangedSearch,
  SteppedSearch,
  ClosedSearch,
  Ticked,
  CompletedRequest,
])
export type Message = typeof Message.Type
