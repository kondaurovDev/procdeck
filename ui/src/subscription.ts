import { Effect, Queue, Schema as S, Stream } from "effect"
import { Subscription } from "foldkit"
import { API, ProcEvent } from "./schema.ts"
import { Message } from "./message.ts"
import type { Model } from "./model.ts"
import { installStream } from "./install.ts"
import { systemSchemeStream } from "./theme.ts"

const decodeEvent = S.decodeUnknownSync(ProcEvent)

/**
 * The SSE feed. EventSource retries on its own while the server is merely
 * unreachable (a `procdeck restart`); it gives up — readyState CLOSED — when
 * the server answers with something that is not an event stream, so that case
 * is retried by hand. Open/drop are reported so the UI can show a banner and
 * refetch the snapshot once the feed is back. The acquireRelease pairs
 * open/close with the subscription scope.
 */
const sseStream: Stream.Stream<Message> = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const RETRY_MS = 2000
      const handle: { source: EventSource | undefined; retry: number | undefined } = {
        source: undefined,
        retry: undefined
      }
      const connect = () => {
        const source = new EventSource(`${API}/events`)
        handle.source = source
        // Every (re)connect starts with each proc's backlog and ends it with
        // a `synced` marker; only what follows is news (unread tallies,
        // notifications).
        let synced = false
        source.addEventListener("open", () => {
          synced = false
          Queue.offerUnsafe(queue, Message.StreamOpened())
        })
        source.addEventListener("error", () => {
          Queue.offerUnsafe(queue, Message.StreamDropped())
          if (source.readyState === EventSource.CLOSED) {
            handle.retry = window.setTimeout(connect, RETRY_MS)
          }
        })
        source.addEventListener("message", (message) => {
          try {
            const event = decodeEvent(JSON.parse(message.data))
            if (event.type === "synced") {
              synced = true
              return
            }
            Queue.offerUnsafe(
              queue,
              event.type === "log"
                ? Message.ReceivedLog({ id: event.id, data: event.data, live: synced })
                : Message.ReceivedStatus({ status: event.status, live: synced })
            )
          } catch {
            // Malformed frame — drop it.
          }
        })
      }
      connect()
      return handle
    }),
    (handle) =>
      Effect.sync(() => {
        window.clearTimeout(handle.retry)
        handle.source?.close()
      })
  )
)

const resizeStream: Stream.Stream<Message> = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const onResize = () => {
        Queue.offerUnsafe(queue, Message.ResizedWindow())
      }
      window.addEventListener("resize", onResize)
      return onResize
    }),
    (onResize) => Effect.sync(() => window.removeEventListener("resize", onResize))
  )
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
    if (event.code === "KeyK") return Message.PressedClear()
    if (event.code === "KeyF") return Message.OpenedSearch()
    return undefined
  }
  if (event.altKey && !event.metaKey && !event.ctrlKey) {
    switch (event.code) {
      case "ArrowUp":
        return Message.SelectedProcOffset({ delta: -1 })
      case "ArrowDown":
        return Message.SelectedProcOffset({ delta: 1 })
      case "KeyR":
        return Message.PressedRestart()
      case "KeyS":
        return Message.PressedToggle()
      case "KeyG":
        return Message.CycledLayout()
      case "KeyP":
        return Message.PressedPin()
      case "KeyZ":
        return Message.ToggledZoom()
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
    (onKeyDown) => Effect.sync(() => window.removeEventListener("keydown", onKeyDown, true))
  )
)

const tickStream: Stream.Stream<Message> = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      setInterval(() => {
        Queue.offerUnsafe(queue, Message.Ticked({ now: Date.now() }))
      }, 1000)
    ),
    (id) => Effect.sync(() => clearInterval(id))
  )
)

/** Traffic-view poll: fires immediately on subscribe, then every second. */
const trafficStream: Stream.Stream<Message> = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      Queue.offerUnsafe(queue, Message.PolledTraffic())
      return setInterval(() => {
        Queue.offerUnsafe(queue, Message.PolledTraffic())
      }, 1000)
    }),
    (id) => Effect.sync(() => clearInterval(id))
  )
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
        ready: model.procs.length > 0 && model.mounted.length >= model.procs.length
      }),
      dependenciesToStream: ({ ready }) => (ready ? sseStream : Stream.empty)
    }
  ),
  resize: entry(
    { active: S.UndefinedOr(S.String) },
    {
      modelToDependencies: (model) => ({ active: model.active }),
      dependenciesToStream: ({ active }) => (active === undefined ? Stream.empty : resizeStream)
    }
  ),
  hotkeys: entry(
    { enabled: S.Boolean },
    {
      modelToDependencies: (model) => ({ enabled: model.procs.length > 0 }),
      dependenciesToStream: ({ enabled }) => (enabled ? hotkeyStream : Stream.empty)
    }
  ),
  // Web-app install offer — listens for the whole session.
  install: entry(
    { on: S.Boolean },
    {
      modelToDependencies: () => ({ on: true }),
      dependenciesToStream: () => installStream
    }
  ),
  // OS light/dark flips. Always on, so `systemDark` is current the moment the
  // user switches back to "system" after a spell on an explicit theme.
  systemScheme: entry(
    { on: S.Boolean },
    {
      modelToDependencies: () => ({ on: true }),
      dependenciesToStream: () => systemSchemeStream
    }
  ),
  // The traffic view's poll — alive only while the view is open and running.
  traffic: entry(
    { on: S.Boolean },
    {
      modelToDependencies: (model) => ({
        on: model.layout === "http" && !model.trafficPaused && model.stream !== "reconnecting"
      }),
      dependenciesToStream: ({ on }) => (on ? trafficStream : Stream.empty)
    }
  ),
  // Uptime / "exited 2m ago" clock — only ticks while there is something to age.
  clock: entry(
    { anyAging: S.Boolean },
    {
      modelToDependencies: (model) => ({
        anyAging: model.procs.some(
          (info) => info.status.state === "running" || info.status.exitedAt !== undefined
        )
      }),
      dependenciesToStream: ({ anyAging }) => (anyAging ? tickStream : Stream.empty)
    }
  )
}))
