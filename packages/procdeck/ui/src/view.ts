import { Option as O } from "effect"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import type { Message } from "./message.ts"
import {
  ChangedSearch,
  ClickedClear,
  ClickedProc,
  ClickedRestart,
  ClickedStart,
  ClickedStop,
  ClosedSearch,
  SteppedSearch,
} from "./message.ts"
import type { Model } from "./model.ts"
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
          h.div(
            [h.Class("name")],
            [
              info.id,
              ...(info.status.alert === undefined
                ? []
                : [h.span([h.Class("badge")], [info.status.alert])]),
              ...(unread === 0
                ? []
                : [
                    h.span(
                      [h.Class("badge err"), h.Title("errors in the log since you last looked")],
                      [unread > 99 ? "99+" : String(unread)],
                    ),
                  ]),
            ],
          ),
          h.div([h.Class("cmd")], [info.command]),
          ...(sub.length === 0 ? [] : [h.div([h.Class("sub")], sub)]),
        ],
      ),
    ],
  )
}

const paneLinks = (info: ProcInfo, h: HtmlBuilder<Message>): Array<Html> => {
  const links: Array<Html> = []
  const link = (href: string, label: string) =>
    h.a([h.Href(href), h.Target("_blank"), h.Class("port")], [label])
  const ports = usefulPorts(info)
  // The stable subdomain address is the primary link once there is anything to
  // proxy to; the raw ports stay available as chips for scripts and curl.
  const proxyable = info.url !== undefined || ports.length > 0
  if (info.proxyUrl !== undefined && proxyable) {
    links.push(link(info.proxyUrl, info.proxyUrl.replace(/^https?:\/\//, "")))
  } else if (info.url !== undefined) {
    links.push(link(info.url, info.url.replace(/^https?:\/\//, "")))
  }
  for (const port of ports) {
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

const header = (model: Model, h: HtmlBuilder<Message>): Html => {
  const active = model.procs.find((info) => info.id === model.active)
  const state = active?.status.state
  const idle = state === "stopped" || state === "exited" || state === "blocked"
  const busy = state === "running" || state === "starting"

  return h.header(
    [],
    [
      h.button(
        [h.Disabled(active === undefined || !busy), h.Title("⌥R"), h.OnClick(ClickedRestart())],
        ["Restart"],
      ),
      // For "waiting" Stop means "cancel waiting for deps" — keep it enabled.
      h.button(
        [h.Disabled(active === undefined || idle), h.Title("⌥S"), h.OnClick(ClickedStop())],
        ["Stop"],
      ),
      h.button(
        [h.Disabled(active === undefined || !idle), h.Title("⌥S"), h.OnClick(ClickedStart())],
        ["Start"],
      ),
      h.button(
        [h.Disabled(active === undefined), h.Title("⌘K"), h.OnClick(ClickedClear())],
        ["Clear"],
      ),
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
      h.span([h.Class("links")], active === undefined ? [] : paneLinks(active, h)),
      h.span(
        [h.Class("meta")],
        [
          model.error !== undefined
            ? model.error
            : active === undefined
              ? ""
              : describeStatus(active.status),
        ],
      ),
    ],
  )
}

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "procdeck",
  body: h.div(
    [h.Class("layout")],
    [
      h.aside(
        [],
        [
          h.h1([], ["procdeck"]),
          h.div(
            [],
            model.procs.map((info) =>
              procRow(info, info.id === model.active, model.unread[info.id] ?? 0, model.now, h),
            ),
          ),
          h.div(
            [h.Class("hints")],
            ["⌥↑↓ switch · ⌥R restart · ⌥S stop/start · ⌘K clear · ⌘F find"],
          ),
        ],
      ),
      h.main(
        [],
        [
          header(model, h),
          h.div(
            [h.Class("terminals")],
            model.procs.map((info) =>
              h.div(
                [
                  h.Key(info.id),
                  h.Class("term"),
                  h.Hidden(info.id !== model.active),
                  h.OnMount(MountTerminal({ id: info.id })),
                ],
                [],
              ),
            ),
          ),
        ],
      ),
    ],
  ),
})
