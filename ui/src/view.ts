import { Option as O } from "effect"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import type { Message } from "./message.ts"
import {
  ChangedSearch,
  ChoseLayout,
  ChoseTheme,
  ClickedInstall,
  ClickedPaneAction,
  ClickedProc,
  ClickedRestartAll,
  ClickedShutdown,
  ClickedStopAll,
  ClosedSearch,
  SteppedSearch,
  ToggledNotifications,
  ToggledPin,
  ToggledSwitcher,
  ZoomedProc
} from "./message.ts"
import { attentionCount, gridIds } from "./model.ts"
import type { Layout, Model, Theme } from "./model.ts"
import type { ProcInfo, ProcStatus } from "./schema.ts"
import { MountTerminal } from "./terminal.ts"
import { trafficView } from "./traffic.ts"

/**
 * Split detected ports into ones a human wants to open and machinery noise.
 * `wrangler dev` alone opens a node inspector (9229+) and a dozen ephemeral
 * workerd control ports (macOS ephemeral range starts at 49152) — real dev
 * servers live below both.
 */
const isInternalPort = (port: number): boolean => port >= 49152 || (port >= 9229 && port <= 9249)

/**
 * Ports worth surfacing: the assigned one (even before the process binds it)
 * plus whatever non-internal ports the tree actually listens on.
 */
const usefulPorts = (info: ProcInfo): Array<number> =>
  [
    ...new Set([
      ...(info.assignedPort === undefined ? [] : [info.assignedPort]),
      ...(info.status.ports ?? []).filter((port) => !isInternalPort(port))
    ])
  ].sort((a, b) => a - b)

/** Machinery ports — minus the assigned one, which is useful whatever its number. */
const internalPorts = (info: ProcInfo): Array<number> =>
  (info.status.ports ?? []).filter((port) => isInternalPort(port) && port !== info.assignedPort)

const portHref = (info: ProcInfo, port: number): string =>
  info.url?.includes(`:${port}`) ? info.url : `http://localhost:${port}`

const formatUptime = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** `exit 1` / `killed (SIGTERM)` — how it ended, nothing else. */
const describeExit = (status: ProcStatus): string =>
  status.signal === undefined ? `exit ${status.exitCode}` : `killed (${status.signal})`

/** `2m 10s ago` for the sidebar and pane header of an exited proc. */
const describeExitedAgo = (status: ProcStatus, now: number): string =>
  status.exitedAt === undefined ? "" : ` · ${formatUptime(now - status.exitedAt)} ago`

const describeStatus = (status: ProcStatus, now: number): string => {
  const base = (() => {
    switch (status.state) {
      case "running":
        return `running · pid ${status.pid}`
      case "waiting":
        return "waiting for deps"
      case "blocked":
        return status.hint === undefined ? "blocked · preflight failed" : `blocked · ${status.hint}`
      case "exited":
        return `${describeExit(status)}${describeExitedAgo(status, now)}`
      default:
        return status.state
    }
  })()
  const restarts = status.restarts === undefined ? "" : ` · ↻${status.restarts}`
  const alert = status.alert === undefined ? "" : ` · ⚠ ${status.alert}`
  return `${base}${restarts}${alert}`
}

/** Alert + unread-error badges, shared by the sidebar row and the grid tile. */
const badges = (info: ProcInfo, unread: number, h: HtmlBuilder<Message>): Array<Html> => [
  ...(info.status.alert === undefined ? [] : [h.span([h.Class("badge")], [info.status.alert])]),
  ...(unread === 0
    ? []
    : [
        h.span(
          [h.Class("badge err"), h.Title("errors in the log since you last looked")],
          [unread > 99 ? "99+" : String(unread)]
        )
      ])
]

/**
 * Pin toggle, shared by the sidebar row, the pane header and the tray. Pinned
 * procs are the grid; an unpinned one lives in the tray while anything is
 * pinned. Never stops propagation — on a sidebar row the click also selects,
 * which is fine; the tray keeps it outside the peek target instead.
 */
const pinButton = (id: string, pinned: boolean, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Class(pinned ? "pin on" : "pin"),
      h.Title(pinned ? "unpin from grid (⌥P)" : "pin to grid (⌥P)"),
      h.OnClick(ToggledPin({ id }))
    ],
    ["📌"]
  )

const procRow = (
  info: ProcInfo,
  isActive: boolean,
  pinned: boolean,
  unread: number,
  now: number,
  h: HtmlBuilder<Message>
): Html => {
  const ports = usefulPorts(info)
  // Right-aligned tail of the row: uptime while running, how it ended once exited.
  const tail =
    info.status.state === "running" && info.status.startedAt !== undefined
      ? formatUptime(now - info.status.startedAt)
      : info.status.state === "exited"
        ? `${describeExit(info.status)}${describeExitedAgo(info.status, now)}`
        : undefined
  const sub: Array<Html> = ports.map((port) =>
    h.a([h.Href(portHref(info, port)), h.Target("_blank"), h.Class("port")], [`:${port}`])
  )
  if (tail !== undefined) {
    sub.push(h.span([h.Class(info.status.state === "exited" ? "up exit" : "up")], [tail]))
  }

  return h.div(
    [
      h.Key(info.id),
      h.Class(isActive ? "proc active" : "proc"),
      h.OnClick(ClickedProc({ id: info.id }))
    ],
    [
      h.span([h.Class(`dot ${info.status.state}`)], []),
      h.div(
        [h.Class("proc-body")],
        [
          h.div(
            [h.Class("name")],
            [info.id, ...badges(info, unread, h), pinButton(info.id, pinned, h)]
          ),
          h.div([h.Class("cmd")], [info.command]),
          ...(sub.length === 0 ? [] : [h.div([h.Class("sub")], sub)])
        ]
      )
    ]
  )
}

/** Pin + Restart / Stop-or-Start / Clear for one pane, as compact icon buttons. */
const paneActions = (info: ProcInfo, pinned: boolean, h: HtmlBuilder<Message>): Html => {
  const { state } = info.status
  const idle = state === "stopped" || state === "exited" || state === "blocked"
  const busy = state === "running" || state === "starting"
  const action = (action: "start" | "stop" | "restart" | "clear") =>
    ClickedPaneAction({ id: info.id, action })
  return h.span(
    [h.Class("pane-actions")],
    [
      pinButton(info.id, pinned, h),
      h.button([h.Disabled(!busy), h.Title("restart (⌥R)"), h.OnClick(action("restart"))], ["↻"]),
      // For "waiting" Stop means "cancel waiting for deps" — keep it enabled.
      idle
        ? h.button([h.Title("start (⌥S)"), h.OnClick(action("start"))], ["▶"])
        : h.button([h.Title("stop (⌥S)"), h.OnClick(action("stop"))], ["■"]),
      h.button([h.Title("clear (⌘K)"), h.OnClick(action("clear"))], ["⌫"])
    ]
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
  const shown =
    model.layout === "http"
      ? false
      : model.layout === "single"
        ? isActive
        : gridIds(model).includes(info.id)
  return h.div(
    [
      h.Key(info.id),
      h.Class(isActive ? "tile active" : "tile"),
      h.Hidden(!shown),
      h.OnClick(ClickedProc({ id: info.id }))
    ],
    [
      // Double-click zooms only from the header: inside xterm it selects a word.
      h.div(
        [
          h.Class("tile-head"),
          h.Title(model.layout === "grid" ? "double-click to zoom" : ""),
          h.OnDoubleClick(ZoomedProc({ id: info.id }))
        ],
        [
          h.span([h.Class(`dot ${info.status.state}`)], []),
          h.span([h.Class("name")], [info.id, ...badges(info, model.unread[info.id] ?? 0, h)]),
          h.span([h.Class("links")], paneLinks(info, model.layout === "grid", h)),
          // Lowest priority for space in the header: ellipsised, full text on hover.
          h.span(
            [h.Class("meta"), h.Title(describeStatus(info.status, model.now))],
            [describeStatus(info.status, model.now)]
          ),
          paneActions(info, model.pinned.includes(info.id), h)
        ]
      ),
      h.div([h.Class("term"), h.OnMount(MountTerminal({ id: info.id }))], [])
    ]
  )
}

/**
 * Grid-only strip below the tiles holding the procs that are not pinned (and
 * so not tiled) — their dot, id and badges stay one glance away, so a crash in
 * an unpinned pane is still seen. Click the name to peek (single on it), pin
 * to put it back in the grid. Absent while nothing is pinned.
 */
const tray = (model: Model, h: HtmlBuilder<Message>): Array<Html> => {
  if (model.layout !== "grid" || model.pinned.length === 0) return []
  const rest = model.procs.filter((info) => !model.pinned.includes(info.id))
  if (rest.length === 0) return []
  return [
    h.div(
      [h.Class("tray")],
      rest.map((info) =>
        h.span(
          [h.Key(info.id), h.Class("tray-item")],
          [
            // The active pane may sit here (after a peek, say): hotkeys still
            // act on it, so it keeps its accent.
            h.button(
              [
                h.Class(info.id === model.active ? "peek active" : "peek"),
                h.Title("peek: show only this pane"),
                h.OnClick(ZoomedProc({ id: info.id }))
              ],
              [
                h.span([h.Class(`dot ${info.status.state}`)], []),
                h.span([h.Class("name")], [info.id, ...badges(info, model.unread[info.id] ?? 0, h)])
              ]
            ),
            pinButton(info.id, false, h)
          ]
        )
      )
    )
  ]
}

/** How many columns the grid uses for n tiles: near-square, capped so tiles stay readable. */
const gridColumns = (n: number): number => Math.max(1, Math.min(4, Math.ceil(Math.sqrt(n))))

const LAYOUT_OPTIONS: ReadonlyArray<{ layout: Layout; label: string; hint: string }> = [
  { layout: "single", label: "▣", hint: "single pane" },
  { layout: "grid", label: "⊞", hint: "grid — all panes tiled" },
  { layout: "http", label: "⇄", hint: "traffic — captured HTTP and WebSocket" }
]

const layoutSwitch = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.span(
    [h.Class("segmented")],
    LAYOUT_OPTIONS.map(({ layout, label, hint }) =>
      h.button(
        [
          h.Class(model.layout === layout ? "on" : ""),
          h.Title(`${hint} (⌥G)`),
          h.OnClick(ChoseLayout({ layout }))
        ],
        [label]
      )
    )
  )

const THEME_OPTIONS: ReadonlyArray<{ theme: Theme; label: string; hint: string }> = [
  { theme: "system", label: "◐", hint: "follow the OS" },
  { theme: "light", label: "☀", hint: "light" },
  { theme: "dark", label: "☾", hint: "dark" }
]

const themeSwitch = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.span(
    [h.Class("segmented theme")],
    THEME_OPTIONS.map(({ theme, label, hint }) =>
      h.button(
        [
          h.Class(model.theme === theme ? "on" : ""),
          h.Title(`theme: ${hint}`),
          h.OnClick(ChoseTheme({ theme }))
        ],
        [label]
      )
    )
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

/**
 * Addresses in a pane header. `compact` (grid tiles) keeps only the primary
 * address — whole, never clipped to `:61` — and moves the raw ports into its
 * tooltip; single layout has the room to show every chip.
 */
const paneLinks = (info: ProcInfo, compact: boolean, h: HtmlBuilder<Message>): Array<Html> => {
  const links: Array<Html> = []
  const link = (href: string, label: string, title?: string) =>
    h.a(
      [
        h.Href(href),
        h.Target("_blank"),
        h.Class("port"),
        ...(title === undefined ? [] : [h.Title(title)])
      ],
      [label]
    )
  const ports = usefulPorts(info)
  const primary = primaryUrl(info)
  if (compact) {
    const portList = ports.map((port) => `:${port}`).join("  ")
    if (primary !== undefined) links.push(link(primary, bareUrl(primary), portList || undefined))
    else if (ports[0] !== undefined)
      links.push(link(portHref(info, ports[0]), `:${ports[0]}`, portList))
    return links
  }
  // The primary address first; the raw ports stay available as chips for
  // scripts and curl.
  if (primary !== undefined) links.push(link(primary, bareUrl(primary)))
  for (const port of ports) {
    links.push(link(portHref(info, port), `:${port}`))
  }
  // Inspector/ephemeral machinery — collapsed into a hoverable count.
  const internal = internalPorts(info)
  if (internal.length > 0) {
    links.push(
      h.span(
        [h.Class("links-more"), h.Title(internal.map((port) => `:${port}`).join("  "))],
        [`+${internal.length} internal`]
      )
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
    (info) => info.status.state !== "stopped" && info.status.state !== "exited"
  )
  return h.header(
    [],
    [
      h.h1([], ["procdeck"]),
      ...(model.deck === undefined ? [] : [deckSwitcher(model, model.deck.name, h)]),
      layoutSwitch(model, h),
      ...(model.search === undefined
        ? []
        : [
            h.input([
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
                    : O.none()
              )
            ])
          ]),
      ...(model.error === undefined ? [] : [h.span([h.Class("meta error")], [model.error])]),
      h.span(
        [h.Class("deck-actions")],
        [
          ...notifyBell(model, h),
          themeSwitch(model, h),
          ...(model.installable
            ? [
                h.button(
                  [
                    h.Class("install"),
                    h.Title("install procdeck as an app: own window, Dock icon"),
                    h.OnClick(ClickedInstall())
                  ],
                  ["⤓ install"]
                )
              ]
            : []),
          h.button(
            [
              h.Disabled(model.procs.length === 0),
              h.Title("restart every proc (stopped ones start)"),
              h.OnClick(ClickedRestartAll())
            ],
            ["↻ all"]
          ),
          h.button(
            [h.Disabled(!anyBusy), h.Title("stop every proc"), h.OnClick(ClickedStopAll())],
            ["■ all"]
          ),
          h.button(
            [
              h.Class("shutdown"),
              h.Disabled(model.shutdown),
              h.Title(
                "shut down procdeck: every proc is terminated (`procdeck up` brings it back)"
              ),
              h.OnClick(ClickedShutdown())
            ],
            ["⏻"]
          )
        ]
      )
    ]
  )
}

/**
 * The deck name doubles as the switcher: every deck on this machine (the
 * instance registry), as plain links — each deck serves its own UI on its own
 * port, so switching is navigation, not proxying.
 */
const deckSwitcher = (model: Model, name: string, h: HtmlBuilder<Message>): Html => {
  const open = model.switcher !== undefined
  const others = (model.switcher ?? []).filter((instance) => !instance.self)
  return h.span(
    [h.Class(open ? "deck open" : "deck")],
    [
      h.button(
        [
          h.Class("deck-name"),
          h.Title("other decks running on this machine"),
          h.OnClick(ToggledSwitcher())
        ],
        [name, h.span([h.Class("caret")], ["▾"])]
      ),
      ...(open
        ? [
            h.div(
              [h.Class("switcher")],
              [
                ...(others.length === 0
                  ? [
                      h.span(
                        [h.Class("meta")],
                        ["no other decks are up — `procdeck up` in another project adds it here"]
                      )
                    ]
                  : others.map((instance) =>
                      h.a(
                        [
                          h.Href(`http://localhost:${instance.port}`),
                          h.Title(
                            `${instance.root} · up ${formatUptime(model.now - instance.startedAt)}${instance.version === undefined ? "" : ` · procdeck v${instance.version}`}`
                          )
                        ],
                        [
                          h.span([h.Class("name")], [instance.name]),
                          h.span([h.Class("meta")], [`:${instance.port}`])
                        ]
                      )
                    )),
                // This deck's own procdeck version — the answer to "which
                // version is this deck actually running?" after an update.
                ...(model.deck?.version === undefined
                  ? []
                  : [h.span([h.Class("meta version")], [`procdeck v${model.deck.version}`])])
              ]
            )
          ]
        : [])
    ]
  )
}

/** `(2) garage · procdeck` — the count of procs wanting attention, visible from the tab strip. */
const title = (model: Model): string => {
  const base = model.deck === undefined ? "procdeck" : `${model.deck.name} · procdeck`
  const attention = attentionCount(model)
  return attention === 0 ? base : `(${attention}) ${base}`
}

/**
 * The bell: system notifications for crashes/alerts while the tab is away.
 * Three looks — off, on, and "on but the browser said no" (denied: the user
 * has to flip it in site settings, we can only say so).
 */
const notifyBell = (model: Model, h: HtmlBuilder<Message>): Array<Html> => {
  if (model.notifyPermission === "unsupported") return []
  const denied = model.notifications && model.notifyPermission === "denied"
  const hint = denied
    ? "notifications are blocked for this site — allow them in the browser's site settings"
    : model.notifications
      ? "notify on crash/alert while the tab is away (on)"
      : "notify on crash/alert while the tab is away (off)"
  return [
    h.button(
      [
        h.Class(denied ? "bell denied" : model.notifications ? "bell on" : "bell"),
        h.Title(hint),
        h.OnClick(ToggledNotifications())
      ],
      [denied ? "🔕" : "🔔"]
    )
  ]
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: title(model),
  body: h.div(
    [h.Class(`layout ${model.layout}${model.shutdown && model.stream !== "open" ? " down" : ""}`)],
    [
      globalBar(model, h),
      // Overlays the top of the work area (same grid cell), so it never
      // shifts the panes; the terminals below are stale until it goes away.
      ...(model.stream === "reconnecting"
        ? [
            h.div(
              [h.Class(model.shutdown ? "banner down" : "banner")],
              [
                model.shutdown
                  ? `procdeck is shut down — \`procdeck up\`${model.deck?.root === undefined ? "" : ` in ${model.deck.root}`} brings it back; this page reconnects by itself`
                  : "reconnecting to procdeck…"
              ]
            )
          ]
        : []),
      h.aside(
        [],
        [
          h.div(
            [],
            model.procs.map((info) =>
              procRow(
                info,
                info.id === model.active,
                model.pinned.includes(info.id),
                model.unread[info.id] ?? 0,
                model.now,
                h
              )
            )
          ),
          h.div(
            [h.Class("hints")],
            [
              "⌥↑↓ switch · ⌥R restart · ⌥S stop/start · ⌥G layout · ⌥Z zoom · ⌥P pin · ⌘K clear · ⌘F find"
            ]
          )
        ]
      ),
      h.main(
        [],
        [
          // Hidden (not unmounted) in the traffic view: the xterm instances
          // keep their scrollback, exactly like hidden tiles in single layout.
          h.div(
            [
              h.Class(`terminals ${model.layout} cols-${gridColumns(gridIds(model).length)}`),
              h.Hidden(model.layout === "http")
            ],
            model.procs.map((info) => tile(info, model, h))
          ),
          ...tray(model, h),
          ...(model.layout === "http" ? [trafficView(model, h)] : [])
        ]
      )
    ]
  )
})
