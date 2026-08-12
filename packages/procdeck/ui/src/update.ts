import { Match as M } from "effect"
import type { Command } from "foldkit"
import { evo } from "foldkit/struct"
import {
  ClearTerminal,
  EndSearch,
  FetchProcs,
  FindInTerminal,
  FitTerminal,
  FocusSearch,
  PostAction,
  PostInput,
  WriteTerminal,
} from "./command.ts"
import type { Message } from "./message.ts"
import type { Model } from "./model.ts"

type Result = readonly [Model, ReadonlyArray<Command.Command<Message>>]

const withAction = (model: Model, action: "start" | "stop" | "restart"): Result =>
  model.active === undefined ? [model, []] : [model, [PostAction({ id: model.active, action })]]

/** Log lines worth badging when they land in a pane the user is not watching. */
const ERROR_PATTERN = /\b(error|exception|fatal|panic|traceback)\b|\bERR\b/i

/** Switch panes: the newly visible proc's unread errors are read by definition. */
const activate = (model: Model, id: string): Result => [
  evo(model, {
    active: () => id,
    unread: ({ [id]: _read, ...rest }) => rest,
  }),
  [FitTerminal({ id })],
]

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
        // The first pane to mount is also the visible one — size it.
        model.active === id ? [FitTerminal({ id })] : [],
      ],
      TypedInput: ({ id, data }) => [model, [PostInput({ id, data })]],

      ClickedProc: ({ id }) => activate(model, id),
      ClickedStart: () => withAction(model, "start"),
      ClickedStop: () => withAction(model, "stop"),
      ClickedRestart: () => withAction(model, "restart"),
      ClickedClear: () =>
        model.active === undefined ? [model, []] : [model, [ClearTerminal({ id: model.active })]],

      SelectedProcOffset: ({ delta }) => {
        if (model.procs.length === 0) return [model, []]
        const index = model.procs.findIndex((info) => info.id === model.active)
        const next = model.procs[(index + delta + model.procs.length) % model.procs.length]!
        return activate(model, next.id)
      },
      PressedToggle: () => {
        const active = model.procs.find((info) => info.id === model.active)
        if (active === undefined) return [model, []]
        const { state } = active.status
        const idle = state === "stopped" || state === "exited" || state === "blocked"
        return withAction(model, idle ? "start" : "stop")
      },

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
      ResizedWindow: () =>
        model.active === undefined ? [model, []] : [model, [FitTerminal({ id: model.active })]],

      Ticked: ({ now }) => [evo(model, { now: () => now }), []],

      CompletedRequest: () => [model, []],
    }),
  )

export const init = (): Result => [
  {
    procs: [],
    active: undefined,
    mounted: [],
    error: undefined,
    search: undefined,
    unread: {},
    now: Date.now(),
  },
  [FetchProcs()],
]
