import { Effect, Schema as S } from "effect"
import { Command } from "foldkit"
import { API, DeckInfo, InstanceInfo, ProcInfo, TrafficResult } from "./schema.ts"
import {
  CompletedRequest,
  FailedFetchProcs,
  GotDeck,
  GotInstances,
  GotProcs,
  GotTraffic,
  ShutDown
} from "./message.ts"
import { Scheme, Theme } from "./model.ts"
import { registry } from "./terminal.ts"
import { THEME_COLOR, xtermTheme } from "./theme.ts"

const postJson = (path: string, body: unknown) =>
  Effect.tryPromise(() =>
    fetch(`${API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
  )

export const FetchProcs = Command.define("FetchProcs", {
  messages: [GotProcs, FailedFetchProcs],
  execute: Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      fetch(`${API}/procs`).then((response) => response.json())
    )
    const procs = yield* S.decodeUnknownEffect(S.Array(ProcInfo))(raw)
    return GotProcs({ procs })
  }).pipe(Effect.catch((error) => Effect.succeed(FailedFetchProcs({ error: String(error) }))))
})

/** Deck name for the tab title. Failure is cosmetic — the UI keeps "procdeck". */
export const FetchDeck = Command.define("FetchDeck", {
  messages: [GotDeck, CompletedRequest],
  execute: Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      fetch(`${API}/deck`).then((response) => response.json())
    )
    const deck = yield* S.decodeUnknownEffect(DeckInfo)(raw)
    return GotDeck({ deck })
  }).pipe(Effect.catch(() => Effect.succeed(CompletedRequest())))
})

/**
 * One traffic poll: everything after the cursor (or the recent tail on the
 * first call), bodies included so expanding a row is instant. Failure is
 * quiet — the next tick retries.
 */
export const FetchTraffic = Command.define("FetchTraffic", {
  args: { sinceSeq: S.UndefinedOr(S.Record(S.String, S.Number)) },
  messages: [GotTraffic, CompletedRequest],
  execute: ({ sinceSeq }) =>
    Effect.gen(function* () {
      const params = new URLSearchParams({ limit: "300", bodies: "1" })
      if (sinceSeq !== undefined && Object.keys(sinceSeq).length > 0) {
        params.set("sinceSeq", JSON.stringify(sinceSeq))
      }
      const raw = yield* Effect.tryPromise(() =>
        fetch(`${API}/http?${params}`).then((response) => response.json())
      )
      const result = yield* S.decodeUnknownEffect(TrafficResult)(raw)
      return GotTraffic({ entries: result.exchanges, nextSeq: result.nextSeq })
    }).pipe(Effect.catch(() => Effect.succeed(CompletedRequest())))
})

/** The registry, for the deck switcher. Failure just leaves the list empty. */
export const FetchInstances = Command.define("FetchInstances", {
  messages: [GotInstances],
  execute: Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      fetch(`${API}/instances`).then((response) => response.json())
    )
    const instances = yield* S.decodeUnknownEffect(S.Array(InstanceInfo))(raw)
    return GotInstances({ instances })
  }).pipe(Effect.catch(() => Effect.succeed(GotInstances({ instances: [] }))))
})

/**
 * Shut the whole deck down — every proc terminated, procdeck exits. There is
 * no terminal to Ctrl-C in detached mode, so this is the off switch; it asks
 * first because it is the one click that undoes everything.
 */
export const Shutdown = Command.define("Shutdown", {
  messages: [ShutDown, CompletedRequest],
  execute: Effect.gen(function* () {
    const sure = yield* Effect.sync(() =>
      window.confirm(
        "Shut down procdeck? Every proc is terminated. Run `procdeck up` to bring the deck back."
      )
    )
    if (!sure) return CompletedRequest()
    yield* postJson("/shutdown", {})
    return ShutDown()
  }).pipe(Effect.catch(() => Effect.succeed(CompletedRequest())))
})

export const PostAction = Command.define("PostAction", {
  args: { id: S.String, action: S.Literals(["start", "stop", "restart"]) },
  messages: [CompletedRequest],
  execute: ({ id, action }) =>
    postJson(`/procs/${encodeURIComponent(id)}/${action}`, {}).pipe(
      Effect.as(CompletedRequest()),
      Effect.catch(() => Effect.succeed(CompletedRequest()))
    )
})

export const PostInput = Command.define("PostInput", {
  args: { id: S.String, data: S.String },
  messages: [CompletedRequest],
  execute: ({ id, data }) =>
    postJson(`/procs/${encodeURIComponent(id)}/input`, { data }).pipe(
      Effect.as(CompletedRequest()),
      Effect.catch(() => Effect.succeed(CompletedRequest()))
    )
})

/** Write a PTY chunk into the pane's xterm instance. */
export const WriteTerminal = Command.define("WriteTerminal", {
  args: { id: S.String, data: S.String },
  messages: [CompletedRequest],
  execute: ({ id, data }) =>
    Effect.sync(() => {
      registry.get(id)?.term.write(data)
      return CompletedRequest()
    })
})

/**
 * Full reset of a pane — before a reconnected feed replays the backlog, so
 * history is not appended to itself. (Unlike `clear`, this also drops the
 * current line and any terminal modes the process had set.)
 */
export const ResetTerminal = Command.define("ResetTerminal", {
  args: { id: S.String },
  messages: [CompletedRequest],
  execute: ({ id }) =>
    Effect.sync(() => {
      registry.get(id)?.term.reset()
      return CompletedRequest()
    })
})

/** Wipe the pane's screen and scrollback (the shell keeps running). */
export const ClearTerminal = Command.define("ClearTerminal", {
  args: { id: S.String },
  messages: [CompletedRequest],
  execute: ({ id }) =>
    Effect.sync(() => {
      registry.get(id)?.term.clear()
      return CompletedRequest()
    })
})

/** Drive the xterm search addon: live-narrowing while typing, stepping on Enter. */
export const FindInTerminal = Command.define("FindInTerminal", {
  args: { id: S.String, query: S.String, mode: S.Literals(["incremental", "next", "previous"]) },
  messages: [CompletedRequest],
  execute: ({ id, query, mode }) =>
    Effect.sync(() => {
      const entry = registry.get(id)
      if (entry === undefined) return CompletedRequest()
      if (query === "") entry.term.clearSelection()
      else if (mode === "previous") entry.search.findPrevious(query)
      else entry.search.findNext(query, { incremental: mode === "incremental" })
      return CompletedRequest()
    })
})

/** Drop the search highlight and hand the keyboard back to the terminal. */
export const EndSearch = Command.define("EndSearch", {
  args: { id: S.String },
  messages: [CompletedRequest],
  execute: ({ id }) =>
    Effect.sync(() => {
      const entry = registry.get(id)
      if (entry !== undefined) {
        entry.term.clearSelection()
        entry.term.focus()
      }
      return CompletedRequest()
    })
})

/**
 * Focus the search input. Runs after the next frame so it also works on the
 * render that just created the input (Commands can outrun the DOM patch).
 */
export const FocusSearch = Command.define("FocusSearch", {
  messages: [CompletedRequest],
  execute: Effect.promise(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  ).pipe(
    Effect.map(() => {
      const input = document.querySelector<HTMLInputElement>("input.search")
      input?.focus()
      input?.select()
      return CompletedRequest()
    })
  )
})

/**
 * Paint the document in the given scheme: the `data-theme` attribute (absent
 * for system, so the CSS media query decides), every mounted terminal's
 * palette, and the theme-color meta.
 */
export const ApplyTheme = Command.define("ApplyTheme", {
  args: { theme: Theme, scheme: Scheme },
  messages: [CompletedRequest],
  execute: ({ theme, scheme }) =>
    Effect.sync(() => {
      const root = document.documentElement
      if (theme === "system") delete root.dataset["theme"]
      else root.dataset["theme"] = theme
      document
        .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.setAttribute("content", THEME_COLOR[scheme])
      for (const entry of registry.values()) entry.term.options.theme = xtermTheme(scheme)
      return CompletedRequest()
    })
})

const nextFrame = Effect.promise(
  () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
)

/**
 * Fit the given panes' terminals to their containers, then tell each PTY its
 * new size; `focus` names the one that should own the keyboard afterwards.
 * Only ever called for visible panes — xterm cannot measure a hidden one.
 * Waits a frame first: a layout switch or pane change is still being patched
 * into the DOM when the Command runs, and fitting against the old boxes
 * would size the terminals for the layout that just went away.
 */
export const FitTerminals = Command.define("FitTerminals", {
  args: { ids: S.Array(S.String), focus: S.UndefinedOr(S.String) },
  messages: [CompletedRequest],
  execute: ({ ids, focus }) =>
    Effect.gen(function* () {
      yield* nextFrame
      for (const id of ids) {
        const entry = registry.get(id)
        if (entry === undefined) continue
        entry.fit.fit()
        yield* postJson(`/procs/${encodeURIComponent(id)}/resize`, {
          cols: entry.term.cols,
          rows: entry.term.rows
        }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      }
      if (focus !== undefined) registry.get(focus)?.term.focus()
      return CompletedRequest()
    })
})
