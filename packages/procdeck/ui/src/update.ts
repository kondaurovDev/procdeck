import { Match as M } from "effect"
import type { Command } from "foldkit"
import { evo } from "foldkit/struct"
import { FetchProcs, FitTerminal, PostAction, PostInput, WriteTerminal } from "./command.ts"
import type { Message } from "./message.ts"
import type { Model } from "./model.ts"

type Result = readonly [Model, ReadonlyArray<Command.Command<Message>>]

const withAction = (model: Model, action: "start" | "stop" | "restart"): Result =>
  model.active === undefined ? [model, []] : [model, [PostAction({ id: model.active, action })]]

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
      ReceivedLog: ({ id, data }) => [model, [WriteTerminal({ id, data })]],

      MountedTerminal: ({ id }) => [
        evo(model, { mounted: (mounted) => [...mounted, id] }),
        // The first pane to mount is also the visible one — size it.
        model.active === id ? [FitTerminal({ id })] : [],
      ],
      TypedInput: ({ id, data }) => [model, [PostInput({ id, data })]],

      ClickedProc: ({ id }) => [evo(model, { active: () => id }), [FitTerminal({ id })]],
      ClickedStart: () => withAction(model, "start"),
      ClickedStop: () => withAction(model, "stop"),
      ClickedRestart: () => withAction(model, "restart"),
      ResizedWindow: () =>
        model.active === undefined ? [model, []] : [model, [FitTerminal({ id: model.active })]],

      Ticked: ({ now }) => [evo(model, { now: () => now }), []],

      CompletedRequest: () => [model, []],
    }),
  )

export const init = (): Result => [
  { procs: [], active: undefined, mounted: [], error: undefined, now: Date.now() },
  [FetchProcs()],
]
