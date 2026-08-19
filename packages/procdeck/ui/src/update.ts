import { Match as M } from "effect"
import type { Command } from "foldkit"
import { evo } from "foldkit/struct"
import {
  ApplyTheme,
  ClearTerminal,
  EndSearch,
  FetchDeck,
  FetchProcs,
  FindInTerminal,
  FitTerminals,
  FocusSearch,
  PostAction,
  PostInput,
  WriteTerminal,
} from "./command.ts"
import { PromptInstall } from "./install.ts"
import type { Message } from "./message.ts"
import { gridIds } from "./model.ts"
import type { Layout, Model } from "./model.ts"
import type { ProcStatus } from "./schema.ts"
import { SaveUiState, loadUiState } from "./storage.ts"
import { resolveScheme, systemPrefersDark } from "./theme.ts"

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
  model.layout === "grid" ? gridIds(model) : model.active === undefined ? [] : [model.active]

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

/** Single on that pane (its unread errors are read by definition). */
const zoomTo = (model: Model, id: string): Result => {
  const next = evo(model, {
    layout: () => "single" as const,
    active: () => id,
    unread: ({ [id]: _read, ...rest }) => rest,
  })
  return [next, [refit(next)]]
}

/** Pinning changes which tiles the grid shows, so the rest need re-measuring. */
const togglePin = (model: Model, id: string | undefined): Result => {
  if (id === undefined) return [model, []]
  const next = evo(model, {
    pinned: (pinned) => (pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id]),
  })
  return [next, model.layout === "grid" ? [refit(next)] : []]
}

const step = (model: Model, message: Message): Result =>
  M.value(message).pipe(
    M.withReturnType<Result>(),
    M.tagsExhaustive({
      GotDeck: ({ deck }) => [evo(model, { deck: () => deck }), []],
      GotProcs: ({ procs }) => [
        evo(model, {
          procs: () => procs,
          // Keep the selection (it may come from localStorage) unless the
          // config no longer has that proc; then the first one. Pins to
          // procs that are gone are dropped the same way.
          active: (active) => (procs.some((info) => info.id === active) ? active : procs[0]?.id),
          pinned: (pinned) => {
            const kept = pinned.filter((id) => procs.some((info) => info.id === id))
            // Same array when nothing was dropped, so the persist check stays quiet.
            return kept.length === pinned.length ? pinned : kept
          },
        }),
        [],
      ],
      FailedFetchProcs: ({ error }) => [evo(model, { error: () => error }), []],

      // Back after a drop: statuses may have changed while we were deaf, and
      // the ring replay is not guaranteed to hold them all — take the snapshot.
      StreamOpened: () => [
        evo(model, { stream: () => "open" as const }),
        model.stream === "reconnecting" ? [FetchProcs()] : [],
      ],
      StreamDropped: () => [evo(model, { stream: () => "reconnecting" as const }), []],

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
      ZoomedProc: ({ id }) => zoomTo(model, id),
      ToggledZoom: () =>
        model.layout === "single"
          ? setLayout(model, "grid")
          : model.active === undefined
            ? [model, []]
            : zoomTo(model, model.active),
      CycledLayout: () =>
        setLayout(model, LAYOUTS[(LAYOUTS.indexOf(model.layout) + 1) % LAYOUTS.length]!),
      ToggledPin: ({ id }) => togglePin(model, id),
      PressedPin: () => togglePin(model, model.active),

      ChoseTheme: ({ theme }) => [evo(model, { theme: () => theme }), []],
      SystemSchemeChanged: ({ dark }) => [evo(model, { systemDark: () => dark }), []],

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

      InstallBecameAvailable: () => [evo(model, { installable: () => true }), []],
      ClickedInstall: () => [model, [PromptInstall()]],
      PromptedInstall: () => [evo(model, { installable: () => false }), []],
      Installed: () => [evo(model, { installable: () => false }), []],

      Ticked: ({ now }) => [evo(model, { now: () => now }), []],

      CompletedRequest: () => [model, []],
    }),
  )

/**
 * `step` plus the effects that follow from *what changed*, not from which
 * Message did it — done here so no future branch can forget them:
 * - a field that survives a reload changed → one SaveUiState;
 * - the theme preference or the scheme it resolves to changed → ApplyTheme.
 */
export const update = (model: Model, message: Message): Result => {
  const [next, commands] = step(model, message)
  const persist =
    next.layout !== model.layout ||
    next.active !== model.active ||
    next.theme !== model.theme ||
    next.pinned !== model.pinned
  const repaint = next.theme !== model.theme || resolveScheme(next) !== resolveScheme(model)
  return [
    next,
    [
      ...commands,
      ...(persist
        ? [
            SaveUiState({
              layout: next.layout,
              active: next.active,
              theme: next.theme,
              pinned: next.pinned,
            }),
          ]
        : []),
      ...(repaint ? [ApplyTheme({ theme: next.theme, scheme: resolveScheme(next) })] : []),
    ],
  ]
}

export const init = (): Result => {
  const stored = loadUiState()
  const model: Model = {
    deck: undefined,
    procs: [],
    // Validated against the config once GotProcs arrives.
    active: stored.active,
    layout: stored.layout ?? "single",
    pinned: stored.pinned ?? [],
    mounted: [],
    error: undefined,
    search: undefined,
    unread: {},
    installable: false,
    now: Date.now(),
    stream: "connecting",
    theme: stored.theme ?? "system",
    systemDark: systemPrefersDark(),
  }
  // The inline script in index.html already painted the scheme before the
  // first frame; this keeps the theme-color meta honest if it did not run.
  return [
    model,
    [FetchProcs(), FetchDeck(), ApplyTheme({ theme: model.theme, scheme: resolveScheme(model) })],
  ]
}
