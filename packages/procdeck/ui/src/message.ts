import { Schema as S } from "effect"
import { m } from "foldkit/message"
import { Layout, Theme } from "./model.ts"
import { DeckInfo, ProcInfo, ProcStatus } from "./schema.ts"

// Server data arriving
export const GotDeck = m("GotDeck", { deck: DeckInfo })
export const GotProcs = m("GotProcs", { procs: S.Array(ProcInfo) })
export const FailedFetchProcs = m("FailedFetchProcs", { error: S.String })
export const ReceivedStatus = m("ReceivedStatus", { status: ProcStatus })
/**
 * `live` is false for chunks replayed from the server's ring buffer right
 * after (re)connect — those land in the terminal but must not count as unread.
 */
export const ReceivedLog = m("ReceivedLog", { id: S.String, data: S.String, live: S.Boolean })
/** The SSE feed (re)connected / dropped — drives the "reconnecting" banner. */
export const StreamOpened = m("StreamOpened")
export const StreamDropped = m("StreamDropped")

// Terminal lifecycle and input
export const MountedTerminal = m("MountedTerminal", { id: S.String })
export const TypedInput = m("TypedInput", { id: S.String, data: S.String })

// User intent
export const ClickedProc = m("ClickedProc", { id: S.String })
/** Pane-header buttons — each pane carries its own controls. */
export const PaneAction = S.Literals(["start", "stop", "restart", "clear"])
export const ClickedPaneAction = m("ClickedPaneAction", { id: S.String, action: PaneAction })
export const ClickedRestartAll = m("ClickedRestartAll")
export const ClickedStopAll = m("ClickedStopAll")
export const ResizedWindow = m("ResizedWindow")

// Layout
export const ChoseLayout = m("ChoseLayout", { layout: Layout })
/** Grid tile double-click: back to single with that pane active. */
export const ZoomedProc = m("ZoomedProc", { id: S.String })

// Theme
export const ChoseTheme = m("ChoseTheme", { theme: Theme })
/** The OS flipped light/dark (matchMedia change). */
export const SystemSchemeChanged = m("SystemSchemeChanged", { dark: S.Boolean })

// Hotkeys — all act on the active pane
export const SelectedProcOffset = m("SelectedProcOffset", { delta: S.Number })
/** ⌥R */
export const PressedRestart = m("PressedRestart")
/** ⌥S: stop the active proc if it is busy, start it if it is idle. */
export const PressedToggle = m("PressedToggle")
/** ⌘K */
export const PressedClear = m("PressedClear")
/** ⌥G: step to the next layout mode. */
export const CycledLayout = m("CycledLayout")

// Log search
export const OpenedSearch = m("OpenedSearch")
export const ChangedSearch = m("ChangedSearch", { query: S.String })
export const SteppedSearch = m("SteppedSearch", { backwards: S.Boolean })
export const ClosedSearch = m("ClosedSearch")

// Web-app install (see install.ts)
export const InstallBecameAvailable = m("InstallBecameAvailable")
export const ClickedInstall = m("ClickedInstall")
export const PromptedInstall = m("PromptedInstall")
export const Installed = m("Installed")

// Uptime clock — fires once a second while anything is running
export const Ticked = m("Ticked", { now: S.Number })

// Fire-and-forget Command acknowledgements (update no-ops on it; keeps the
// side effect visible to DevTools and tests)
export const CompletedRequest = m("CompletedRequest")

export const Message = S.Union([
  GotDeck,
  GotProcs,
  FailedFetchProcs,
  ReceivedStatus,
  ReceivedLog,
  StreamOpened,
  StreamDropped,
  MountedTerminal,
  TypedInput,
  ClickedProc,
  ClickedPaneAction,
  ClickedRestartAll,
  ClickedStopAll,
  ResizedWindow,
  ChoseLayout,
  ZoomedProc,
  ChoseTheme,
  SystemSchemeChanged,
  SelectedProcOffset,
  PressedRestart,
  PressedToggle,
  PressedClear,
  CycledLayout,
  OpenedSearch,
  ChangedSearch,
  SteppedSearch,
  ClosedSearch,
  InstallBecameAvailable,
  ClickedInstall,
  PromptedInstall,
  Installed,
  Ticked,
  CompletedRequest,
])
export type Message = typeof Message.Type
