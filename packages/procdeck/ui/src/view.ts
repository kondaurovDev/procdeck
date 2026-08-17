import { Option as O } from "effect"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import type { Message } from "./message.ts"
import {
  ChangedSearch,
  ChoseLayout,
  ClickedInstall,
  ClickedPaneAction,
  ClickedProc,
  ClickedRestartAll,
  ClickedStopAll,
  ClosedSearch,
  SteppedSearch,
  ZoomedProc,
} from "./message.ts"
import type { Layout, Model } from "./model.ts"
import type { ProcInfo, ProcStatus } from "./schema.ts"
import { MountTerminal } from "./terminal.ts"

/**
 * Split detected ports into ones a human wants to open and machinery noise.
 * `wrangler dev` alone opens a node inspector (9229+) and a dozen ephemeral
 * workerd control ports (macOS ephemeral range starts at 49152) — real dev
 * servers live below both.
 */
const isInternalPort = (port: number): boolean =>
  port >= 49152 || (port >= 9229 && port <= 9249)

/**
 * Ports worth surfacing: the assigned one (even before the process binds it)
 * plus whatever non-internal ports the tree actually listens on.
 */
const usefulPorts = (info: ProcInfo): Array<number> =>
  [
    ...new Set([
      ...(info.assignedPort === undefined ? [] : [info.assignedPort]),
      ...(info.status.ports ?? []).filter((port) => !isInternalPort(port)),
    ]),
  ].sort((a, b) => a - b)

const internalPorts = (info: ProcInfo): Array<number> =>
  (info.status.ports ?? []).filter(isInternalPort)

const portHref = (info: ProcInfo, port: number): string =>
  info.url?.includes(`:${port}`) ? info.url : `http://localhost:${port}`

const formatUptime = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const describeStatus = (status: ProcStatus): string => {
  const base = (() => {
    switch (status.state) {
      case "running":
        return `running · pid ${status.pid}`
      case "waiting":
        return "waiting for deps"
      case "blocked":
        return status.hint === undefined ? "blocked · preflight failed" : `blocked · ${status.hint}`
      case "exited":
        return status.signal === undefined
          ? `exited · code ${status.exitCode}`
          : `exited · signal ${status.signal}`
      default:
        return status.state
    }
  })()
  return status.alert === undefined ? base : `${base} · ⚠ ${status.alert}`
}

/** Alert + unread-error badges, shared by the sidebar row and the grid tile. */
const badges = (info: ProcInfo, unread: number, h: HtmlBuilder<Message>): Array<Html> => [
  ...(info.status.alert === undefined ? [] : [h.span([h.Class("badge")], [info.status.alert])]),
  ...(unread === 0
    ? []
    : [
        h.span(
          [h.Class("badge err"), h.Title("errors in the log since you last looked")],
          [unread > 99 ? "99+" : String(unread)],
        ),
      ]),
]

const procRow = (
  info: ProcInfo,
  isActive: boolean,
  unread: number,
  now: number,
  h: HtmlBuilder<Message>,
): Html => {
  const ports = usefulPorts(info)
  const uptime =
    info.status.state === "running" && info.status.startedAt !== undefined
      ? formatUptime(now - info.status.startedAt)
      : undefined
  const sub: Array<Html> = ports.map((port) =>
    h.a([h.Href(portHref(info, port)), h.Target("_blank"), h.Class("port")], [`:${port}`]),
  )
  if (uptime !== undefined) sub.push(h.span([h.Class("up")], [uptime]))

  return h.div(
    [
      h.Key(info.id),
      h.Class(isActive ? "proc active" : "proc"),
      h.OnClick(ClickedProc({ id: info.id })),
    ],
    [
      h.span([h.Class(`dot ${info.status.state}`)], []),
      h.div(
        [h.Class("proc-body")],
        [
          h.div([h.Class("name")], [info.id, ...badges(info, unread, h)]),
          h.div([h.Class("cmd")], [info.command]),
          ...(sub.length === 0 ? [] : [h.div([h.Class("sub")], sub)]),
        ],
      ),
    ],
  )
}

/** Restart / Stop-or-Start / Clear for one pane, as compact icon buttons. */
const paneActions = (info: ProcInfo, h: HtmlBuilder<Message>): Html => {
  const { state } = info.status
  const idle = state === "stopped" || state === "exited" || state === "blocked"
  const busy = state === "running" || state === "starting"
  const action = (action: "start" | "stop" | "restart" | "clear") =>
    ClickedPaneAction({ id: info.id, action })
  return h.span(
    [h.Class("pane-actions")],
    [
      h.button(
        [h.Disabled(!busy), h.Title("restart (⌥R)"), h.OnClick(action("restart"))],
        ["↻"],
      ),
      // For "waiting" Stop means "cancel waiting for deps" — keep it enabled.
      idle
        ? h.button([h.Title("start (⌥S)"), h.OnClick(action("start"))], ["▶"])
        : h.button([h.Title("stop (⌥S)"), h.OnClick(action("stop"))], ["■"]),
      h.button([h.Title("clear (⌘K)"), h.OnClick(action("clear"))], ["⌫"]),
    ],
  )
}

/**
 * One pane in the main area: a header (dot, id, badges, addresses, status,
 * controls) over its terminal. The same element serves both layouts, so the
 * terminal element keeps its position under the wrapper across switches (a
 * re-created element would remount xterm and lose the scrollback).
 */
const tile = (info: ProcInfo, model: Model, h: HtmlBuilder<Message>): Html => {
  const isActive = info.id === model.active
  return h.div(
    [
      h.Key(info.id),
      h.Class(isActive ? "tile active" : "tile"),
      h.Hidden(model.layout === "single" && !isActive),
      h.OnClick(ClickedProc({ id: info.id })),
    ],
    [
      // Double-click zooms only from the header: inside xterm it selects a word.
      h.div(
        [
          h.Class("tile-head"),
          h.Title(model.layout === "grid" ? "double-click to zoom" : ""),
          h.OnDoubleClick(ZoomedProc({ id: info.id })),
        ],
        [
          h.span([h.Class(`dot ${info.status.state}`)], []),
          h.span([h.Class("name")], [info.id, ...badges(info, model.unread[info.id] ?? 0, h)]),
          h.span([h.Class("links")], paneLinks(info, h)),
          h.span([h.Class("meta")], [describeStatus(info.status)]),
          paneActions(info, h),
        ],
      ),
      h.div([h.Class("term"), h.OnMount(MountTerminal({ id: info.id }))], []),
    ],
  )
}

const LAYOUT_OPTIONS: ReadonlyArray<{ layout: Layout; label: string; hint: string }> = [
  { layout: "single", label: "▣", hint: "single pane" },
  { layout: "grid", label: "⊞", hint: "grid — all panes tiled" },
]

const layoutSwitch = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.span(
    [h.Class("segmented")],
    LAYOUT_OPTIONS.map(({ layout, label, hint }) =>
      h.button(
        [
          h.Class(model.layout === layout ? "on" : ""),
          h.Title(`${hint} (⌥G)`),
          h.OnClick(ChoseLayout({ layout })),
        ],
        [label],
      ),
    ),
  )

/**
 * The address a human opens for this pane: the stable subdomain once there is
 * anything to proxy to, else the declared url, else nothing.
 */
const primaryUrl = (info: ProcInfo): string | undefined =>
  info.proxyUrl !== undefined && (info.url !== undefined || usefulPorts(info).length > 0)
    ? info.proxyUrl
    : info.url

const bareUrl = (url: string): string => url.replace(/^https?:\/\//, "")

const paneLinks = (info: ProcInfo, h: HtmlBuilder<Message>): Array<Html> => {
  const links: Array<Html> = []
  const link = (href: string, label: string) =>
    h.a([h.Href(href), h.Target("_blank"), h.Class("port")], [label])
  // The primary address first; the raw ports stay available as chips for
  // scripts and curl.
  const primary = primaryUrl(info)
  if (primary !== undefined) links.push(link(primary, bareUrl(primary)))
  for (const port of usefulPorts(info)) {
    links.push(link(portHref(info, port), `:${port}`))
  }
  // Inspector/ephemeral machinery — collapsed into a hoverable count.
  const internal = internalPorts(info)
  if (internal.length > 0) {
    links.push(
      h.span(
        [h.Class("links-more"), h.Title(internal.map((port) => `:${port}`).join("  "))],
        [`+${internal.length} internal`],
      ),
    )
  }
  return links
}

/**
 * The global bar: brand, layout switch, log search, deck-wide actions. Nothing
 * here is about one pane — per-pane controls live in the pane header.
 */
const globalBar = (model: Model, h: HtmlBuilder<Message>): Html => {
  const anyBusy = model.procs.some(
    (info) => info.status.state !== "stopped" && info.status.state !== "exited",
  )
  return h.header(
    [],
    [
      h.h1([], ["procdeck"]),
      ...(model.deck === undefined ? [] : [h.span([h.Class("deck-name")], [model.deck.name])]),
      layoutSwitch(model, h),
      ...(model.search === undefined
        ? []
        : [
            h.input(
              [
                h.Class("search"),
                h.Type("text"),
                h.Value(model.search),
                h.Placeholder("find…"),
                h.Title("Enter next · ⇧Enter prev · Esc close"),
                h.Autofocus(true),
                h.OnInput((query) => ChangedSearch({ query })),
                h.OnKeyDownPreventDefault((key, modifiers) =>
                  key === "Enter"
                    ? O.some(SteppedSearch({ backwards: modifiers.shiftKey }))
                    : key === "Escape"
                      ? O.some(ClosedSearch())
                      : O.none(),
                ),
              ],
            ),
          ]),
      ...(model.error === undefined ? [] : [h.span([h.Class("meta error")], [model.error])]),
      h.span(
        [h.Class("deck-actions")],
        [
          ...(model.installable
            ? [
                h.button(
                  [
                    h.Class("install"),
                    h.Title("install procdeck as an app: own window, Dock icon"),
                    h.OnClick(ClickedInstall()),
                  ],
                  ["⤓ install"],
                ),
              ]
            : []),
          h.button(
            [
              h.Disabled(model.procs.length === 0),
              h.Title("restart every proc (stopped ones start)"),
              h.OnClick(ClickedRestartAll()),
            ],
            ["↻ all"],
          ),
          h.button(
            [h.Disabled(!anyBusy), h.Title("stop every proc"), h.OnClick(ClickedStopAll())],
            ["■ all"],
          ),
        ],
      ),
    ],
  )
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: model.deck === undefined ? "procdeck" : `${model.deck.name} · procdeck`,
  body: h.div(
    [h.Class(`layout ${model.layout}`)],
    [
      globalBar(model, h),
      h.aside(
        [],
        [
          h.div(
            [],
            model.procs.map((info) =>
              procRow(info, info.id === model.active, model.unread[info.id] ?? 0, model.now, h),
            ),
          ),
          h.div(
            [h.Class("hints")],
            ["⌥↑↓ switch · ⌥R restart · ⌥S stop/start · ⌥G layout · ⌘K clear · ⌘F find"],
          ),
        ],
      ),
      h.main(
        [],
        [
          h.div(
            [h.Class(`terminals ${model.layout}`)],
            model.procs.map((info) => tile(info, model, h)),
          ),
        ],
      ),
    ],
  ),
})
