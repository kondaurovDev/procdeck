import { Schema as S } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { Layout, NotifyPermission, Theme, TrafficKind } from "./model.ts"
import { DeckInfo, InstanceInfo, ProcInfo, ProcStatus, TrafficEntry } from "./schema.ts"

/** Pane-header buttons — each pane carries its own controls. */
export const PaneAction = S.Literals(["start", "stop", "restart", "clear"])

/**
 * Every Message the UI handles, one record: the key is the tag, the value its
 * fields. `Message.X(...)` constructs, `Message.match` dispatches exhaustively.
 */
export const Message = defineMessageUnion({
  // Server data arriving
  GotDeck: { deck: DeckInfo },
  GotProcs: { procs: S.Array(ProcInfo) },
  FailedFetchProcs: { error: S.String },
  /**
   * `live` is false for events replayed from the server's ring buffer right
   * after (re)connect — replayed chunks land in the terminal but must not
   * count as unread, and a replayed crash must not notify again.
   */
  ReceivedStatus: { status: ProcStatus, live: S.Boolean },
  ReceivedLog: { id: S.String, data: S.String, live: S.Boolean },
  /** The SSE feed (re)connected / dropped — drives the "reconnecting" banner. */
  StreamOpened: {},
  StreamDropped: {},

  // Terminal lifecycle and input
  MountedTerminal: { id: S.String },
  TypedInput: { id: S.String, data: S.String },

  // User intent
  ClickedProc: { id: S.String },
  ClickedPaneAction: { id: S.String, action: PaneAction },
  ClickedRestartAll: {},
  ClickedStopAll: {},
  /** The ⏻ button: the whole deck, not one proc. `ShutDown` = the server said ok. */
  ClickedShutdown: {},
  ShutDown: {},
  /** Deck name in the bar toggles the switcher; `GotInstances` fills it. */
  ToggledSwitcher: {},
  GotInstances: { instances: S.Array(InstanceInfo) },
  ResizedWindow: {},

  // Layout
  ChoseLayout: { layout: Layout },
  /** Grid tile double-click / tray click: single with that pane active. */
  ZoomedProc: { id: S.String },
  /** ⌥Z: grid → single on the active pane, single → grid. */
  ToggledZoom: {},
  /** Pin icon on a pane header / sidebar row / tray item. */
  ToggledPin: { id: S.String },
  /** ⌥P: pin/unpin the active pane. */
  PressedPin: {},

  // Notifications
  ToggledNotifications: {},
  GotNotifyPermission: { permission: NotifyPermission },

  // Theme
  ChoseTheme: { theme: Theme },
  /** The OS flipped light/dark (matchMedia change). */
  SystemSchemeChanged: { dark: S.Boolean },

  // Hotkeys — all act on the active pane
  SelectedProcOffset: { delta: S.Number },
  /** ⌥R */
  PressedRestart: {},
  /** ⌥S: stop the active proc if it is busy, start it if it is idle. */
  PressedToggle: {},
  /** ⌘K */
  PressedClear: {},
  /** ⌥G: step to the next layout mode. */
  CycledLayout: {},

  // Log search
  OpenedSearch: {},
  ChangedSearch: { query: S.String },
  SteppedSearch: { backwards: S.Boolean },
  ClosedSearch: {},

  // Traffic view (the layout's "http" position) — a 1s poll of GET /http with
  // a per-proc seq cursor, active only while the view is open and not paused.
  PolledTraffic: {},
  GotTraffic: { entries: S.Array(TrafficEntry), nextSeq: S.Record(S.String, S.Number) },
  ChoseTrafficKind: { kind: TrafficKind },
  ToggledTrafficErrors: {},
  ChoseTrafficProc: { id: S.UndefinedOr(S.String) },
  /** Click a row to expand its bodies/headers; clicking again closes it. */
  ToggledTrafficRow: { key: S.String },
  ClearedTraffic: {},
  ToggledTrafficPause: {},

  // Web-app install (see install.ts)
  InstallBecameAvailable: {},
  ClickedInstall: {},
  PromptedInstall: {},
  Installed: {},

  // Uptime clock — fires once a second while anything is running
  Ticked: { now: S.Number },

  // Fire-and-forget Command acknowledgements (update no-ops on it; keeps the
  // side effect visible to DevTools and tests)
  CompletedRequest: {}
})
export type Message = typeof Message.Type
