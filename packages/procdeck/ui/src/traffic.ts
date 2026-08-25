import type { Html, HtmlBuilder } from "foldkit/html"
import type { Message } from "./message.ts"
import {
  ChoseTrafficKind,
  ChoseTrafficProc,
  ClearedTraffic,
  ToggledTrafficErrors,
  ToggledTrafficPause,
  ToggledTrafficRow
} from "./message.ts"
import type { Model, TrafficKind } from "./model.ts"
import type { TrafficEntry } from "./schema.ts"

/**
 * The traffic view — the layout's "http" position: what the deck's HTTP
 * observer captured (docs/http-observability.md), newest first, polled while
 * the view is open. The UI face of `procdeck http`.
 */

const clock = (ts: number): string => {
  const date = new Date(ts)
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

const size = (bytes: number | undefined): string =>
  bytes === undefined ? "" : bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}kB`

const isWs = (entry: TrafficEntry): boolean => entry.kind === "ws"

const isFailure = (entry: TrafficEntry): boolean =>
  !isWs(entry) && ((entry.status ?? 0) >= 400 || entry.status === 0)

const statusClass = (status: number | undefined): string => {
  if (status === undefined) return "meta"
  if (status === 0 || status >= 500) return "status bad"
  if (status >= 400) return "status warn"
  if (status >= 300) return "status meta"
  return "status ok"
}

const rowKey = (entry: TrafficEntry): string => `${entry.proc}#${entry.seq}`

const shown = (model: Model, entry: TrafficEntry): boolean =>
  (model.trafficProc === undefined || entry.proc === model.trafficProc) &&
  (model.trafficKind === "all" || isWs(entry) === (model.trafficKind === "ws")) &&
  (!model.trafficErrorsOnly || isFailure(entry))

/** The expanded row body: headers and bodies (http) or the message (ws). */
const detail = (entry: TrafficEntry, h: HtmlBuilder<Message>): Html => {
  const block = (label: string, content: string | undefined): Array<Html> =>
    content === undefined || content.length === 0
      ? []
      : [h.div([h.Class("detail-label")], [label]), h.pre([], [content])]
  const headers = (record: Record<string, string> | undefined): string | undefined =>
    record === undefined
      ? undefined
      : Object.entries(record)
          .map(([name, value]) => `${name}: ${value}`)
          .join("\n")
  if (isWs(entry)) {
    return h.div(
      [h.Class("traffic-detail")],
      [...block("message", entry.text ?? `(${entry.opcode ?? "binary"}, ${size(entry.size)})`)]
    )
  }
  return h.div(
    [h.Class("traffic-detail")],
    [
      ...block("request headers", headers(entry.reqHeaders)),
      ...block("request body", entry.reqBody),
      ...block("response headers", headers(entry.resHeaders)),
      ...block("response body", entry.resBody),
      ...(entry.reqBody === undefined && entry.resBody === undefined
        ? [h.div([h.Class("detail-label")], ["no captured bodies (binary or empty)"])]
        : [])
    ]
  )
}

const row = (entry: TrafficEntry, open: boolean, h: HtmlBuilder<Message>): Array<Html> => {
  const key = rowKey(entry)
  const head = isWs(entry)
    ? [
        // "→" flows into the proc (client → server), "←" out of it.
        h.span([h.Class("method ws")], [entry.dir === "in" ? "ws→" : "ws←"]),
        h.span([h.Class("path"), h.Title(entry.path)], [entry.text ?? `(${entry.opcode ?? "?"})`]),
        h.span([h.Class("status ws")], [`#${entry.connId ?? "?"}`]),
        h.span([h.Class("meta")], [""]),
        h.span([h.Class("meta")], [size(entry.size)])
      ]
    : [
        h.span([h.Class("method")], [entry.method ?? "?"]),
        h.span([h.Class("path"), h.Title(entry.path)], [entry.path]),
        h.span(
          [h.Class(statusClass(entry.status))],
          [entry.status === 0 ? "refused" : String(entry.status ?? "?")]
        ),
        h.span([h.Class("meta")], [entry.durationMs === undefined ? "" : `${entry.durationMs}ms`]),
        h.span([h.Class("meta")], [size(entry.resBytes)])
      ]
  return [
    h.div(
      [
        h.Key(key),
        h.Class(open ? "traffic-row open" : "traffic-row"),
        h.OnClick(ToggledTrafficRow({ key }))
      ],
      [
        h.span([h.Class("meta")], [clock(entry.ts)]),
        h.span([h.Class("proc-tag")], [entry.proc]),
        ...head
      ]
    ),
    ...(open ? [detail(entry, h)] : [])
  ]
}

const KIND_OPTIONS: ReadonlyArray<{ kind: TrafficKind; label: string; hint: string }> = [
  { kind: "all", label: "all", hint: "http and ws interleaved" },
  { kind: "http", label: "http", hint: "only http exchanges" },
  { kind: "ws", label: "ws", hint: "only WebSocket messages" }
]

const toolbar = (model: Model, shownCount: number, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("traffic-bar")],
    [
      h.span(
        [h.Class("segmented")],
        KIND_OPTIONS.map(({ kind, label, hint }) =>
          h.button(
            [
              h.Class(model.trafficKind === kind ? "on" : ""),
              h.Title(hint),
              h.OnClick(ChoseTrafficKind({ kind }))
            ],
            [label]
          )
        )
      ),
      h.button(
        [
          h.Class(model.trafficErrorsOnly ? "on" : ""),
          h.Title("only 4xx / 5xx / refused"),
          h.OnClick(ToggledTrafficErrors())
        ],
        ["errors"]
      ),
      h.span(
        [h.Class("segmented procs")],
        [
          h.button(
            [
              h.Class(model.trafficProc === undefined ? "on" : ""),
              h.OnClick(ChoseTrafficProc({ id: undefined }))
            ],
            ["all procs"]
          ),
          ...model.procs.map((info) =>
            h.button(
              [
                h.Class(model.trafficProc === info.id ? "on" : ""),
                h.OnClick(ChoseTrafficProc({ id: info.id }))
              ],
              [info.id]
            )
          )
        ]
      ),
      h.span([h.Class("traffic-spacer")], []),
      h.span([h.Class("meta")], [`${shownCount} shown`]),
      h.button(
        [
          h.Class(model.trafficPaused ? "on" : ""),
          h.Title(model.trafficPaused ? "resume capture display" : "pause capture display"),
          h.OnClick(ToggledTrafficPause())
        ],
        [model.trafficPaused ? "▶" : "⏸"]
      ),
      h.button(
        [h.Title("clear the list (capture keeps running)"), h.OnClick(ClearedTraffic())],
        ["⌫"]
      )
    ]
  )

export const trafficView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const entries = model.traffic.filter((entry) => shown(model, entry))
  return h.div(
    [h.Class("traffic")],
    [
      toolbar(model, entries.length, h),
      h.div(
        [h.Class("traffic-list")],
        entries.length === 0
          ? [
              h.div(
                [h.Class("traffic-empty")],
                [
                  "no captured traffic yet — requests to the panes' *.localhost addresses and to assigned ${port} ports land here (hardcoded ports and calls out to the internet are not seen); `procdeck http` shows the same stream in the terminal"
                ]
              )
            ]
          : // Newest first, so the latest exchange is always in sight.
            entries
              .toReversed()
              .flatMap((entry) => row(entry, model.trafficOpen === rowKey(entry), h))
      )
    ]
  )
}
