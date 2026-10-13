import { Schema as S } from "effect"
import { DeckInfo, InstanceInfo, ProcInfo, TrafficEntry } from "./schema.ts"
import type { ProcStatus } from "./schema.ts"

/**
 * How the main area shows the panes. One switch, not independent toggles —
 * "http" is the traffic view (captured HTTP exchanges and WebSocket
 * messages, docs/design/http-observability.md); a future "merged" (single
 * chronological log stream) would be the fourth position of the same
 * control. See docs/design/plan.md, "Layout modes".
 */
export const Layout = S.Literals(["single", "grid", "http"])
export type Layout = typeof Layout.Type

/** Traffic-view kind filter. */
export const TrafficKind = S.Literals(["all", "http", "ws"])
export type TrafficKind = typeof TrafficKind.Type

/**
 * The SSE feed's health. `connecting` until the first open (no banner — the
 * page is still loading), `reconnecting` after a drop (banner) — the server is
 * restarting or gone, and the panes are stale until it is back.
 */
export const StreamState = S.Literals(["connecting", "open", "reconnecting"])
export type StreamState = typeof StreamState.Type

/** The user's colour preference; `system` follows the OS. */
export const Theme = S.Literals(["system", "light", "dark"])
export type Theme = typeof Theme.Type
/** What is actually painted — `Theme` resolved against the OS setting. */
export const Scheme = S.Literals(["light", "dark"])
export type Scheme = typeof Scheme.Type

/** `Notification.permission`, plus "unsupported" for browsers without the API. */
export const NotifyPermission = S.Literals(["default", "granted", "denied", "unsupported"])
export type NotifyPermission = typeof NotifyPermission.Type

export const Model = S.Struct({
  /** Deck name for the title; undefined until fetched. */
  deck: S.UndefinedOr(DeckInfo),
  procs: S.Array(ProcInfo),
  /**
   * Selected pane id. Every layout has exactly one active proc: header
   * buttons, ⌥R/⌥S and ⌘K/⌘F act on it; grid marks it with a frame.
   */
  active: S.UndefinedOr(S.String),
  layout: Layout,
  /**
   * Procs the user wants in the grid. Non-empty → grid shows only these and
   * the rest collapse into the tray; empty → the grid shows everyone.
   */
  pinned: S.Array(S.String),
  /**
   * Ids whose xterm instance has mounted. The SSE subscription is gated on
   * every pane being mounted, so the replayed backlog always has somewhere to
   * land — ordering as a Model condition instead of imperative sequencing.
   */
  mounted: S.Array(S.String),
  error: S.UndefinedOr(S.String),
  /** Log search query; undefined means the search box is closed. */
  search: S.UndefinedOr(S.String),
  /**
   * Per-proc count of error-looking log lines that arrived while another pane
   * was visible. Cleared the moment the proc is selected.
   */
  unread: S.Record(S.String, S.Number),
  /** The browser has offered a web-app install we can trigger (install.ts). */
  installable: S.Boolean,
  /** Wall clock driving the uptime display; advanced by Ticked. */
  now: S.Number,
  stream: StreamState,
  theme: Theme,
  /** The OS preference, tracked so `system` can be resolved without asking the DOM. */
  systemDark: S.Boolean,
  /** The user wants system notifications for crashes/alerts while the tab is away. */
  notifications: S.Boolean,
  notifyPermission: NotifyPermission,
  /**
   * The user shut the deck down from the UI (or `procdeck down` did): the
   * feed is gone on purpose, so the banner says so instead of "reconnecting".
   * Cleared when the feed comes back — `procdeck up` revives the page.
   */
  shutdown: S.Boolean,
  /** Deck switcher dropdown: undefined = closed, else the registry as fetched. */
  switcher: S.UndefinedOr(S.Array(InstanceInfo)),
  /**
   * The traffic view's rolling window of captured entries, appended by the
   * poll while the view is open, capped in update.ts. Filters below narrow
   * what is *shown*, never what is kept.
   */
  traffic: S.Array(TrafficEntry),
  /** Per-proc poll cursor — a `GET /http` response's nextSeq, merged. */
  trafficSeq: S.UndefinedOr(S.Record(S.String, S.Number)),
  trafficKind: TrafficKind,
  /** Show only 4xx/5xx/refused exchanges. */
  trafficErrorsOnly: S.Boolean,
  /** Show only this proc's entries; undefined = every proc. */
  trafficProc: S.UndefinedOr(S.String),
  /** Expanded row (`proc#seq`), showing bodies and headers. */
  trafficOpen: S.UndefinedOr(S.String),
  /** Paused: keep what is on screen, stop appending. */
  trafficPaused: S.Boolean
})
export type Model = typeof Model.Type

/** A crash, as opposed to a clean exit or a stop the user asked for. */
export const isCrash = (status: ProcStatus): boolean =>
  status.state === "exited" && (status.exitCode !== 0 || status.signal !== undefined)

/**
 * Procs that want a human: crashed, blocked on a preflight, carrying an alert,
 * or with unread error lines. Drives the title prefix and the favicon badge.
 */
export const attentionCount = (model: Model): number =>
  model.procs.filter(
    (info) =>
      isCrash(info.status) ||
      info.status.state === "blocked" ||
      info.status.alert !== undefined ||
      (model.unread[info.id] ?? 0) > 0
  ).length

/** Procs tiled in grid layout: the pinned ones, or everyone when nothing is pinned. */
export const gridIds = (model: Model): Array<string> =>
  model.procs
    .map((info) => info.id)
    .filter((id) => model.pinned.length === 0 || model.pinned.includes(id))
