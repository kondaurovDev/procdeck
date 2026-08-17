import { Effect, Queue, Schema as S, Stream } from "effect"
import { Subscription } from "foldkit"
import { API, ProcEvent } from "./schema.ts"
import {
  CycledLayout,
  OpenedSearch,
  PressedClear,
  PressedRestart,
  PressedToggle,
  ReceivedLog,
  ReceivedStatus,
  ResizedWindow,
  SelectedProcOffset,
  Ticked,
} from "./message.ts"
import type { Message } from "./message.ts"
import type { Model } from "./model.ts"
import { installStream } from "./install.ts"

const decodeEvent = S.decodeUnknownSync(ProcEvent)

/**
 * The SSE feed. EventSource reconnects on its own; the acquireRelease pairs
 * open/close with the subscription scope.
 */
const sseStream: Stream.Stream<Message> = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const source = new EventSource(`${API}/events`)
      // The server replays its ring buffer on every (re)connect; it arrives
      // as a burst right after `open`. There is no end-of-replay marker, so
      // anything inside this window after connecting is treated as backlog.
      const REPLAY_WINDOW_MS = 500
      let openedAt = Number.POSITIVE_INFINITY
      source.addEventListener("open", () => {
        openedAt = Date.now()
      })
      source.addEventListener("message", (message) => {
        try {
          const event = decodeEvent(JSON.parse(message.data))
          Queue.offerUnsafe(
            queue,
            event.type === "log"
              ? ReceivedLog({
                  id: event.id,
                  data: event.data,
                  live: Date.now() - openedAt > REPLAY_WINDOW_MS,
                })
              : ReceivedStatus({ status: event.status }),
          )
        } catch {
          // Malformed frame — drop it.
        }
      })
      return source
    }),
    (source) => Effect.sync(() => source.close()),
  ),
)

const resizeStream: Stream.Stream<Message> = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const onResize = () => {
        Queue.offerUnsafe(queue, ResizedWindow())
      }
      window.addEventListener("resize", onResize)
      return onResize
    }),
    (onResize) => Effect.sync(() => window.removeEventListener("resize", onResize)),
  ),
).pipe(Stream.debounce("150 millis"))

const isMac = /Mac|iP/.test(navigator.platform)

/**
 * Hotkeys are modifier-only on purpose: bare keys must keep reaching the PTY
 * (the panes are real interactive terminals). ⌘ on macOS / Ctrl elsewhere for
 * browser-ish chords, ⌥ for procdeck actions. Plain Ctrl is left alone — the
 * shell owns Ctrl+K, Ctrl+F and friends.
 */
const hotkeyMessage = (event: KeyboardEvent): Message | undefined => {
  const mod = isMac ? event.metaKey : event.ctrlKey
  if (mod && !event.altKey) {
    if (event.code === "KeyK") return PressedClear()
    if (event.code === "KeyF") return OpenedSearch()
    return undefined
  }
  if (event.altKey && !event.metaKey && !event.ctrlKey) {
    switch (event.code) {
      case "ArrowUp":
        return SelectedProcOffset({ delta: -1 })
      case "ArrowDown":
        return SelectedProcOffset({ delta: 1 })
      case "KeyR":
        return PressedRestart()
      case "KeyS":
        return PressedToggle()
      case "KeyG":
        return CycledLayout()
    }
  }
  return undefined
}

const hotkeyStream: Stream.Stream<Message> = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      // Capture phase, so a recognised chord never reaches xterm's textarea
      // (which would forward it to the PTY as input).
      const onKeyDown = (event: KeyboardEvent) => {
        const message = hotkeyMessage(event)
        if (message === undefined) return
        event.preventDefault()
        event.stopPropagation()
        Queue.offerUnsafe(queue, message)
      }
      window.addEventListener("keydown", onKeyDown, true)
      return onKeyDown
    }),
    (onKeyDown) => Effect.sync(() => window.removeEventListener("keydown", onKeyDown, true)),
  ),
)

const tickStream: Stream.Stream<Message> = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      setInterval(() => {
        Queue.offerUnsafe(queue, Ticked({ now: Date.now() }))
      }, 1000),
    ),
    (id) => Effect.sync(() => clearInterval(id)),
  ),
)

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  /**
   * Gated on every pane's terminal being mounted: the server replays its ring
   * buffer on connect, and the backlog needs terminals to land in. Ordering
   * expressed as a Model condition, not imperative sequencing.
   */
  events: entry(
    { ready: S.Boolean },
    {
      modelToDependencies: (model) => ({
        ready: model.procs.length > 0 && model.mounted.length >= model.procs.length,
      }),
      dependenciesToStream: ({ ready }) => (ready ? sseStream : Stream.empty),
    },
  ),
  resize: entry(
    { active: S.UndefinedOr(S.String) },
    {
      modelToDependencies: (model) => ({ active: model.active }),
      dependenciesToStream: ({ active }) => (active === undefined ? Stream.empty : resizeStream),
    },
  ),
  hotkeys: entry(
    { enabled: S.Boolean },
    {
      modelToDependencies: (model) => ({ enabled: model.procs.length > 0 }),
      dependenciesToStream: ({ enabled }) => (enabled ? hotkeyStream : Stream.empty),
    },
  ),
  // Web-app install offer — listens for the whole session.
  install: entry(
    { on: S.Boolean },
    {
      modelToDependencies: () => ({ on: true }),
      dependenciesToStream: () => installStream,
    },
  ),
  // Uptime clock — only ticks while something is actually running.
  clock: entry(
    { anyRunning: S.Boolean },
    {
      modelToDependencies: (model) => ({
        anyRunning: model.procs.some((info) => info.status.state === "running"),
      }),
      dependenciesToStream: ({ anyRunning }) => (anyRunning ? tickStream : Stream.empty),
    },
  ),
}))
