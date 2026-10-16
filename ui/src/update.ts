import type { Command, Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import {
  ApplyTheme,
  ClearTerminal,
  EndSearch,
  FetchDeck,
  FetchInstances,
  FetchProcs,
  FetchTraffic,
  FindInTerminal,
  FitTerminals,
  FocusSearch,
  PostAction,
  PostInput,
  ResetTerminal,
  Shutdown,
  WriteTerminal
} from "./command.ts"
import { PromptInstall } from "./install.ts"
import { Message } from "./message.ts"
import { attentionCount, gridIds, isCrash } from "./model.ts"
import type { Layout, Model } from "./model.ts"
import {
  Notify,
  RequestNotifyPermission,
  SetFaviconBadge,
  currentNotifyPermission
} from "./notify.ts"
import type { ProcStatus } from "./schema.ts"
import { SaveUiState, loadUiState } from "./storage.ts"
import { resolveScheme, systemPrefersDark } from "./theme.ts"

type Result = Update.Return<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message>>

/** One pane's control — the header buttons and the hotkeys both end up here. */
const paneAction = (
  model: Model,
  id: string | undefined,
  action: "start" | "stop" | "restart" | "clear"
): Result =>
  id === undefined
    ? { model }
    : action === "clear"
      ? { model, commands: [ClearTerminal({ id })] }
      : { model, commands: [PostAction({ id, action })] }

const isIdle = (state: ProcStatus["state"]): boolean =>
  state === "stopped" || state === "exited" || state === "blocked"

/**
 * A status change worth a system notification: a fresh crash, a fresh
 * preflight block, a new alert. Only transitions — a crashed proc staying
 * crashed (ports poll, resize) must not nag. The Command itself stays quiet
 * while the deck is on screen.
 */
const notifyOnTransition = (
  model: Model,
  before: ProcStatus | undefined,
  after: ProcStatus
): Commands => {
  if (!model.notifications || model.notifyPermission !== "granted") return []
  const tag = `procdeck:${after.id}`
  if (isCrash(after) && (before === undefined || !isCrash(before))) {
    const how = after.signal === undefined ? `exit ${after.exitCode}` : `killed (${after.signal})`
    return [Notify({ title: `${after.id} crashed`, body: how, tag })]
  }
  if (after.state === "blocked" && before?.state !== "blocked") {
    return [Notify({ title: `${after.id} blocked`, body: after.hint ?? "preflight failed", tag })]
  }
  if (after.alert !== undefined && before?.alert !== after.alert) {
    return [Notify({ title: `${after.id}: ${after.alert}`, body: "output alert", tag })]
  }
  return []
}

/** Log lines worth badging when they land in a pane the user is not watching. */
const ERROR_PATTERN = /\b(error|exception|fatal|panic|traceback)\b|\bERR\b/i

/** Panes whose terminal is on screen — the only ones xterm can measure. */
const visibleIds = (model: Model): Array<string> =>
  model.layout === "grid"
    ? gridIds(model)
    : model.layout === "http" || model.active === undefined
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
  const next = modifyFields(model, {
    active: () => id,
    unread: ({ [id]: _read, ...rest }) => rest
  })
  return { model: next, commands: [refit(next)] }
}

const LAYOUTS: ReadonlyArray<Layout> = ["single", "grid", "http"]

/** Entries the traffic view keeps; the server rings hold more, `procdeck http` has it all. */
const TRAFFIC_CAP = 400

const setLayout = (model: Model, layout: Layout): Result => {
  if (layout === model.layout) return { model }
  const next = modifyFields(model, { layout: () => layout })
  return { model: next, commands: [refit(next)] }
}

/** Single on that pane (its unread errors are read by definition). */
const zoomTo = (model: Model, id: string): Result => {
  const next = modifyFields(model, {
    layout: () => "single" as const,
    active: () => id,
    unread: ({ [id]: _read, ...rest }) => rest
  })
  return { model: next, commands: [refit(next)] }
}

/** Pinning changes which tiles the grid shows, so the rest need re-measuring. */
const togglePin = (model: Model, id: string | undefined): Result => {
  if (id === undefined) return { model }
  const next = modifyFields(model, {
    pinned: (pinned) => (pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id])
  })
  return { model: next, commands: model.layout === "grid" ? [refit(next)] : [] }
}

const step = (model: Model, message: Message): Result =>
  Message.match<Result>(message, {
    GotDeck: ({ deck }) => ({ model: modifyFields(model, { deck: () => deck }) }),
    GotProcs: ({ procs }) => ({
      model: modifyFields(model, {
        procs: () => procs,
        // Keep the selection (it may come from localStorage) unless the
        // config no longer has that proc; then the first one. Pins to
        // procs that are gone are dropped the same way.
        active: (active) => (procs.some((info) => info.id === active) ? active : procs[0]?.id),
        pinned: (pinned) => {
          const kept = pinned.filter((id) => procs.some((info) => info.id === id))
          // Same array when nothing was dropped, so the persist check stays quiet.
          return kept.length === pinned.length ? pinned : kept
        }
      })
    }),
    FailedFetchProcs: ({ error }) => ({ model: modifyFields(model, { error: () => error }) }),

    // Back after a drop: statuses may have changed while we were deaf, and
    // the ring replay is not guaranteed to hold them all — take the snapshot.
    StreamOpened: () => ({
      model: modifyFields(model, { stream: () => "open" as const, shutdown: () => false }),
      // Back after a drop: the feed replays every backlog, so the panes
      // start from blank (Commands run in order, and these are synchronous,
      // so the resets land before the first replayed chunk). After a
      // shutdown the server is a fresh process: take the snapshot and the
      // deck info again (the config may have changed).
      commands:
        model.stream === "reconnecting"
          ? [...model.mounted.map((id) => ResetTerminal({ id })), FetchProcs(), FetchDeck()]
          : []
    }),
    StreamDropped: () => ({
      model: modifyFields(model, { stream: () => "reconnecting" as const })
    }),

    ReceivedStatus: ({ status, live }) => {
      const before = model.procs.find((info) => info.id === status.id)?.status
      const next = modifyFields(model, {
        procs: (procs) => procs.map((info) => (info.id === status.id ? { ...info, status } : info))
      })
      // Replayed history walks through old transitions — none of them is news.
      return { model: next, commands: live ? notifyOnTransition(next, before, status) : [] }
    },
    // Log chunks do not live in the Model — the view never renders them, the
    // terminals do. The Message becomes a Command writing into the registry.
    // The one thing the Model keeps is the unread-error tally for panes the
    // user is not looking at.
    ReceivedLog: ({ id, data, live }) => ({
      model:
        live && id !== model.active && ERROR_PATTERN.test(data)
          ? modifyFields(model, {
              unread: (unread) => ({ ...unread, [id]: (unread[id] ?? 0) + 1 })
            })
          : model,
      commands: [WriteTerminal({ id, data })]
    }),

    MountedTerminal: ({ id }) => ({
      model: modifyFields(model, { mounted: (mounted) => [...mounted, id] }),
      // Size it if it is on screen (the active pane, or any pane in grid).
      commands: visibleIds(model).includes(id)
        ? [FitTerminals({ ids: [id], focus: model.active })]
        : []
    }),
    TypedInput: ({ id, data }) => ({ model, commands: [PostInput({ id, data })] }),

    ClickedProc: ({ id }) => activate(model, id),
    ClickedPaneAction: ({ id, action }) => paneAction(model, id, action),
    // Restart is stop+start on the server, so it also brings up stopped procs.
    ClickedRestartAll: () => ({
      model,
      commands: model.procs.map((info) => PostAction({ id: info.id, action: "restart" }))
    }),
    ClickedStopAll: () => ({
      model,
      commands: model.procs
        .filter((info) => !isIdle(info.status.state))
        .map((info) => PostAction({ id: info.id, action: "stop" }))
    }),
    ClickedShutdown: () => ({ model, commands: [Shutdown()] }),
    ShutDown: () => ({
      model: modifyFields(model, { shutdown: () => true, switcher: () => undefined })
    }),
    ToggledSwitcher: () =>
      model.switcher === undefined
        ? { model, commands: [FetchInstances()] }
        : { model: modifyFields(model, { switcher: () => undefined }) },
    GotInstances: ({ instances }) => ({
      model: modifyFields(model, { switcher: () => instances })
    }),

    ChoseLayout: ({ layout }) => setLayout(model, layout),
    ZoomedProc: ({ id }) => zoomTo(model, id),
    ToggledZoom: () =>
      model.layout === "single"
        ? setLayout(model, "grid")
        : model.active === undefined
          ? { model }
          : zoomTo(model, model.active),
    CycledLayout: () =>
      setLayout(model, LAYOUTS[(LAYOUTS.indexOf(model.layout) + 1) % LAYOUTS.length]!),
    ToggledPin: ({ id }) => togglePin(model, id),
    PressedPin: () => togglePin(model, model.active),

    // Turning the bell on asks the browser (a user gesture, so it may
    // prompt); off is just the flag — the permission stays for next time.
    ToggledNotifications: () =>
      model.notifications
        ? { model: modifyFields(model, { notifications: () => false }) }
        : {
            model: modifyFields(model, { notifications: () => true }),
            commands: [RequestNotifyPermission()]
          },
    GotNotifyPermission: ({ permission }) => ({
      model: modifyFields(model, { notifyPermission: () => permission })
    }),

    ChoseTheme: ({ theme }) => ({ model: modifyFields(model, { theme: () => theme }) }),
    SystemSchemeChanged: ({ dark }) => ({
      model: modifyFields(model, { systemDark: () => dark })
    }),

    SelectedProcOffset: ({ delta }) => {
      if (model.procs.length === 0) return { model }
      const index = model.procs.findIndex((info) => info.id === model.active)
      const next = model.procs[(index + delta + model.procs.length) % model.procs.length]!
      return activate(model, next.id)
    },
    PressedRestart: () => paneAction(model, model.active, "restart"),
    PressedToggle: () => {
      const active = model.procs.find((info) => info.id === model.active)
      if (active === undefined) return { model }
      return paneAction(model, active.id, isIdle(active.status.state) ? "start" : "stop")
    },
    PressedClear: () => paneAction(model, model.active, "clear"),

    OpenedSearch: () => ({
      model: modifyFields(model, { search: (search) => search ?? "" }),
      // Also fires when the box is already open: ⌘F refocuses and selects.
      commands: [FocusSearch()]
    }),
    ChangedSearch: ({ query }) => ({
      model: modifyFields(model, { search: () => query }),
      commands:
        model.active === undefined
          ? []
          : [FindInTerminal({ id: model.active, query, mode: "incremental" })]
    }),
    SteppedSearch: ({ backwards }) =>
      model.active === undefined || model.search === undefined || model.search === ""
        ? { model }
        : {
            model,
            commands: [
              FindInTerminal({
                id: model.active,
                query: model.search,
                mode: backwards ? "previous" : "next"
              })
            ]
          },
    ClosedSearch: () => ({
      model: modifyFields(model, { search: () => undefined }),
      commands: model.active === undefined ? [] : [EndSearch({ id: model.active })]
    }),
    ResizedWindow: () =>
      model.active === undefined ? { model } : { model, commands: [refit(model)] },

    PolledTraffic: () => ({ model, commands: [FetchTraffic({ sinceSeq: model.trafficSeq })] }),
    GotTraffic: ({ entries, nextSeq }) => ({
      model: modifyFields(model, {
        traffic: (traffic) =>
          entries.length === 0 ? traffic : [...traffic, ...entries].slice(-TRAFFIC_CAP),
        trafficSeq: (cursor) => ({ ...cursor, ...nextSeq })
      })
    }),
    ChoseTrafficKind: ({ kind }) => ({ model: modifyFields(model, { trafficKind: () => kind }) }),
    ToggledTrafficErrors: () => ({
      model: modifyFields(model, { trafficErrorsOnly: (errorsOnly) => !errorsOnly })
    }),
    ChoseTrafficProc: ({ id }) => ({ model: modifyFields(model, { trafficProc: () => id }) }),
    ToggledTrafficRow: ({ key }) => ({
      model: modifyFields(model, { trafficOpen: (open) => (open === key ? undefined : key) })
    }),
    // Keeps the cursor: what was on screen goes away, only news comes back.
    ClearedTraffic: () => ({
      model: modifyFields(model, { traffic: () => [], trafficOpen: () => undefined })
    }),
    ToggledTrafficPause: () => ({
      model: modifyFields(model, { trafficPaused: (paused) => !paused })
    }),

    InstallBecameAvailable: () => ({ model: modifyFields(model, { installable: () => true }) }),
    ClickedInstall: () => ({ model, commands: [PromptInstall()] }),
    PromptedInstall: () => ({ model: modifyFields(model, { installable: () => false }) }),
    Installed: () => ({ model: modifyFields(model, { installable: () => false }) }),

    Ticked: ({ now }) => ({ model: modifyFields(model, { now: () => now }) }),

    CompletedRequest: () => ({ model })
  })

/**
 * `step` plus the effects that follow from *what changed*, not from which
 * Message did it — done here so no future branch can forget them:
 * - a field that survives a reload changed → one SaveUiState;
 * - the theme preference or the scheme it resolves to changed → ApplyTheme;
 * - the deck started or stopped wanting attention → favicon badge on/off.
 */
export const update = (model: Model, message: Message): Result => {
  const { model: next, commands = [] } = step(model, message)
  const persist =
    next.layout !== model.layout ||
    next.active !== model.active ||
    next.theme !== model.theme ||
    next.pinned !== model.pinned ||
    next.notifications !== model.notifications
  const repaint = next.theme !== model.theme || resolveScheme(next) !== resolveScheme(model)
  const attention = attentionCount(next) > 0
  const rebadge = attention !== attentionCount(model) > 0
  return {
    model: next,
    commands: [
      ...commands,
      ...(persist
        ? [
            SaveUiState({
              layout: next.layout,
              active: next.active,
              theme: next.theme,
              pinned: next.pinned,
              notifications: next.notifications
            })
          ]
        : []),
      ...(repaint ? [ApplyTheme({ theme: next.theme, scheme: resolveScheme(next) })] : []),
      ...(rebadge ? [SetFaviconBadge({ on: attention })] : [])
    ]
  }
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
    notifications: stored.notifications ?? false,
    notifyPermission: currentNotifyPermission(),
    shutdown: false,
    switcher: undefined,
    traffic: [],
    trafficSeq: undefined,
    trafficKind: "all",
    trafficErrorsOnly: false,
    trafficProc: undefined,
    trafficOpen: undefined,
    trafficPaused: false
  }
  // The inline script in index.html already painted the scheme before the
  // first frame; this keeps the theme-color meta honest if it did not run.
  return {
    model,
    commands: [
      FetchProcs(),
      FetchDeck(),
      ApplyTheme({ theme: model.theme, scheme: resolveScheme(model) })
    ]
  }
}
