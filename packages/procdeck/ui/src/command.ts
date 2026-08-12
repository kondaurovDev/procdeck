import { Effect, Schema as S } from "effect"
import { Command } from "foldkit"
import { API, ProcInfo } from "./schema.ts"
import { CompletedRequest, FailedFetchProcs, GotProcs } from "./message.ts"
import { registry } from "./terminal.ts"

const postJson = (path: string, body: unknown) =>
  Effect.tryPromise(() =>
    fetch(`${API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )

export const FetchProcs = Command.define("FetchProcs", {
  messages: [GotProcs, FailedFetchProcs],
  execute: Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      fetch(`${API}/procs`).then((response) => response.json()),
    )
    const procs = yield* S.decodeUnknownEffect(S.Array(ProcInfo))(raw)
    return GotProcs({ procs })
  }).pipe(Effect.catch((error) => Effect.succeed(FailedFetchProcs({ error: String(error) })))),
})

export const PostAction = Command.define("PostAction", {
  args: { id: S.String, action: S.Literals(["start", "stop", "restart"]) },
  messages: [CompletedRequest],
  execute: ({ id, action }) =>
    postJson(`/procs/${encodeURIComponent(id)}/${action}`, {}).pipe(
      Effect.as(CompletedRequest()),
      Effect.catch(() => Effect.succeed(CompletedRequest())),
    ),
})

export const PostInput = Command.define("PostInput", {
  args: { id: S.String, data: S.String },
  messages: [CompletedRequest],
  execute: ({ id, data }) =>
    postJson(`/procs/${encodeURIComponent(id)}/input`, { data }).pipe(
      Effect.as(CompletedRequest()),
      Effect.catch(() => Effect.succeed(CompletedRequest())),
    ),
})

/** Write a PTY chunk into the pane's xterm instance. */
export const WriteTerminal = Command.define("WriteTerminal", {
  args: { id: S.String, data: S.String },
  messages: [CompletedRequest],
  execute: ({ id, data }) =>
    Effect.sync(() => {
      registry.get(id)?.term.write(data)
      return CompletedRequest()
    }),
})

/** Wipe the pane's screen and scrollback (the shell keeps running). */
export const ClearTerminal = Command.define("ClearTerminal", {
  args: { id: S.String },
  messages: [CompletedRequest],
  execute: ({ id }) =>
    Effect.sync(() => {
      registry.get(id)?.term.clear()
      return CompletedRequest()
    }),
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
    }),
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
    }),
})

/**
 * Focus the search input. Runs after the next frame so it also works on the
 * render that just created the input (Commands can outrun the DOM patch).
 */
export const FocusSearch = Command.define("FocusSearch", {
  messages: [CompletedRequest],
  execute: Effect.promise(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  ).pipe(
    Effect.map(() => {
      const input = document.querySelector<HTMLInputElement>("input.search")
      input?.focus()
      input?.select()
      return CompletedRequest()
    }),
  ),
})

/**
 * Fit the pane's terminal to its container, then tell the PTY the new size.
 * Only ever called for the visible pane — xterm cannot measure a hidden one.
 */
export const FitTerminal = Command.define("FitTerminal", {
  args: { id: S.String },
  messages: [CompletedRequest],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const entry = registry.get(id)
      if (entry === undefined) return CompletedRequest()
      entry.fit.fit()
      entry.term.focus()
      yield* postJson(`/procs/${encodeURIComponent(id)}/resize`, {
        cols: entry.term.cols,
        rows: entry.term.rows,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      return CompletedRequest()
    }),
})
