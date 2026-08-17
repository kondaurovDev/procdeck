import { Match as M } from "effect"
import type { Command } from "foldkit"
import { evo } from "foldkit/struct"
import {
  ClearTerminal,
  EndSearch,
  FetchProcs,
  FindInTerminal,
  FitTerminals,
  FocusSearch,
  PostAction,
  PostInput,
  WriteTerminal,
} from "./command.ts"
import type { Message } from "./message.ts"
import type { Layout, Model } from "./model.ts"
import type { ProcStatus } from "./schema.ts"

type Result = readonly [Model, ReadonlyArray<Command.Command<Message>>]

/** One pane's control — the header buttons and the hotkeys both end up here. */
const paneAction = (
  model: Model,
  id: string | undefined,
  action: "start" | "stop" | "restart" | "clear",
): Result =>
  id === undefined
    ? [model, []]
    : action === "clear"
      ? [model, [ClearTerminal({ id })]]
      : [model, [PostAction({ id, action })]]

const isIdle = (state: ProcStatus["state"]): boolean =>
  state === "stopped" || state === "exited" || state === "blocked"

/** Log lines worth badging when they land in a pane the user is not watching. */
const ERROR_PATTERN = /\b(error|exception|fatal|panic|traceback)\b|\bERR\b/i

/** Panes whose terminal is on screen — the only ones xterm can measure. */
const visibleIds = (model: Model): Array<string> =>
  model.layout === "grid"
    ? model.procs.map((info) => info.id)
    : model.active === undefined
      ? []
      : [model.active]

/** Re-measure whatever is on screen and hand the keyboard to the active pane. */
const refit = (model: Model): Command.Command<Message> =>
  FitTerminals({ ids: visibleIds(model), focus: model.active })

/**
 * Switch the active pane: its unread errors are read by definition. In single
 * layout this also swaps which terminal is visible, hence the refit.
 */
const activate = (model: Model, id: string): Result => {
  const next = evo(model, {
    active: () => id,
    unread: ({ [id]: _read, ...rest }) => rest,
  })
  return [next, [refit(next)]]
}

const LAYOUTS: ReadonlyArray<Layout> = ["single", "grid"]

const setLayout = (model: Model, layout: Layout): Result => {
  if (layout === model.layout) return [model, []]
  const next = evo(model, { layout: () => layout })
  return [next, [refit(next)]]
}

export const update = (model: Model, message: Message): Result =>
  M.value(message).pipe(
    M.withReturnType<Result>(),
    M.tagsExhaustive({
      GotProcs: ({ procs }) => [
        evo(model, {
          procs: () => procs,
          active: (active) => active ?? procs[0]?.id,
        }),
        [],
      ],
      FailedFetchProcs: ({ error }) => [evo(model, { error: () => error }), []],

      ReceivedStatus: ({ status }) => [
        evo(model, {
          procs: (procs) =>
            procs.map((info) => (info.id === status.id ? { ...info, status } : info)),
        }),
        [],
      ],
      // Log chunks do not live in the Model — the view never renders them, the
      // terminals do. The Message becomes a Command writing into the registry.
      // The one thing the Model keeps is the unread-error tally for panes the
      // user is not looking at.
      ReceivedLog: ({ id, data, live }) => [
        live && id !== model.active && ERROR_PATTERN.test(data)
          ? evo(model, { unread: (unread) => ({ ...unread, [id]: (unread[id] ?? 0) + 1 }) })
          : model,
        [WriteTerminal({ id, data })],
      ],

      MountedTerminal: ({ id }) => [
        evo(model, { mounted: (mounted) => [...mounted, id] }),
        // Size it if it is on screen (the active pane, or any pane in grid).
        visibleIds(model).includes(id) ? [FitTerminals({ ids: [id], focus: model.active })] : [],
      ],
      TypedInput: ({ id, data }) => [model, [PostInput({ id, data })]],

      ClickedProc: ({ id }) => activate(model, id),
      ClickedPaneAction: ({ id, action }) => paneAction(model, id, action),
      // Restart is stop+start on the server, so it also brings up stopped procs.
      ClickedRestartAll: () => [
        model,
        model.procs.map((info) => PostAction({ id: info.id, action: "restart" })),
      ],
      ClickedStopAll: () => [
        model,
        model.procs
          .filter((info) => !isIdle(info.status.state))
          .map((info) => PostAction({ id: info.id, action: "stop" })),
      ],

      ChoseLayout: ({ layout }) => setLayout(model, layout),
      ZoomedProc: ({ id }) => {
        const next = evo(model, {
          layout: () => "single" as const,
          active: () => id,
          unread: ({ [id]: _read, ...rest }) => rest,
        })
        return [next, [refit(next)]]
      },
      CycledLayout: () =>
        setLayout(model, LAYOUTS[(LAYOUTS.indexOf(model.layout) + 1) % LAYOUTS.length]!),

      SelectedProcOffset: ({ delta }) => {
        if (model.procs.length === 0) return [model, []]
        const index = model.procs.findIndex((info) => info.id === model.active)
        const next = model.procs[(index + delta + model.procs.length) % model.procs.length]!
        return activate(model, next.id)
      },
      PressedRestart: () => paneAction(model, model.active, "restart"),
      PressedToggle: () => {
        const active = model.procs.find((info) => info.id === model.active)
        if (active === undefined) return [model, []]
        return paneAction(model, active.id, isIdle(active.status.state) ? "start" : "stop")
      },
      PressedClear: () => paneAction(model, model.active, "clear"),

      OpenedSearch: () => [
        evo(model, { search: (search) => search ?? "" }),
        // Also fires when the box is already open: ⌘F refocuses and selects.
        [FocusSearch()],
      ],
      ChangedSearch: ({ query }) => [
        evo(model, { search: () => query }),
        model.active === undefined
          ? []
          : [FindInTerminal({ id: model.active, query, mode: "incremental" })],
      ],
      SteppedSearch: ({ backwards }) =>
        model.active === undefined || model.search === undefined || model.search === ""
          ? [model, []]
          : [
              model,
              [
                FindInTerminal({
                  id: model.active,
                  query: model.search,
                  mode: backwards ? "previous" : "next",
                }),
              ],
            ],
      ClosedSearch: () => [
        evo(model, { search: () => undefined }),
        model.active === undefined ? [] : [EndSearch({ id: model.active })],
      ],
      ResizedWindow: () => (model.active === undefined ? [model, []] : [model, [refit(model)]]),

      Ticked: ({ now }) => [evo(model, { now: () => now }), []],

      CompletedRequest: () => [model, []],
    }),
  )

export const init = (): Result => [
  {
    procs: [],
    active: undefined,
    layout: "single",
    mounted: [],
    error: undefined,
    search: undefined,
    unread: {},
    now: Date.now(),
  },
  [FetchProcs()],
]
