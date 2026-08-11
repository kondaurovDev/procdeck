import { Effect, Queue, Schema as S, Stream } from "effect"
import { Subscription } from "foldkit"
import { API, ProcEvent } from "./schema.ts"
import { ReceivedLog, ReceivedStatus, ResizedWindow, Ticked } from "./message.ts"
import type { Message } from "./message.ts"
import type { Model } from "./model.ts"

const decodeEvent = S.decodeUnknownSync(ProcEvent)

/**
 * The SSE feed. EventSource reconnects on its own; the acquireRelease pairs
 * open/close with the subscription scope.
 */
const sseStream: Stream.Stream<Message> = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const source = new EventSource(`${API}/events`)
      source.addEventListener("message", (message) => {
        try {
          const event = decodeEvent(JSON.parse(message.data))
          Queue.offerUnsafe(
            queue,
            event.type === "log"
              ? ReceivedLog({ id: event.id, data: event.data })
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
