import { createServer as createNetServer } from "node:net"
import { describe, expect, test } from "vitest"
import { Effect, Queue, Stream } from "effect"
import type { LoadedConfig } from "../src/config.ts"
import type { ProcEvent } from "../src/events.ts"
import { findFreePorts } from "../src/ports.ts"
import { isGroupAlive } from "../src/proc.ts"
import { makeSupervisor } from "../src/supervisor.ts"

const loaded = (procs: LoadedConfig["config"]["procs"]): LoadedConfig => ({
  config: { procs },
  root: process.cwd(),
  name: "test"
})

const LONG_RUNNER = ["node", "-e", 'console.log("up"); setInterval(() => {}, 1000)']

/** Pull events from a subscription until one satisfies the predicate. */
const takeUntil = Effect.fn("takeUntil")(function* (
  subscription: Queue.Dequeue<ProcEvent, unknown>,
  predicate: (event: ProcEvent) => boolean
) {
  while (true) {
    const event = yield* Queue.take(subscription)
    if (predicate(event)) return event
  }
})

describe("supervisor", () => {
  test("autostarts procs, streams logs, reports exit", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([{ id: "hello", cmd: ["node", "-e", 'console.log("hello-from-child")'] }])
          )
          // Subscribing after the fact still sees the backlog: per-proc buffers.
          const subscription = yield* Stream.toQueue(supervisor.events, { capacity: "unbounded" })
          yield* takeUntil(
            subscription,
            (event) => event.type === "log" && event.data.includes("hello-from-child")
          )
          yield* takeUntil(
            subscription,
            (event) =>
              event.type === "status" &&
              event.status.state === "exited" &&
              event.status.exitCode === 0
          )
        })
      )
    )
  })

  test("restart swaps the pid and kills the old group", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(loaded([{ id: "runner", cmd: LONG_RUNNER }]))
          const before = supervisor.list()[0]!.status.pid!
          expect(isGroupAlive(before)).toBe(true)

          yield* supervisor.restart("runner")

          const after = supervisor.list()[0]!.status
          expect(after.state).toBe("running")
          expect(after.pid).not.toBe(before)
          expect(isGroupAlive(before)).toBe(false)
          expect(isGroupAlive(after.pid!)).toBe(true)
        })
      )
    )
  })

  test("stop terminates the group and reports stopped", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(loaded([{ id: "runner", cmd: LONG_RUNNER }]))
          const pid = supervisor.list()[0]!.status.pid!

          yield* supervisor.stop("runner")

          expect(isGroupAlive(pid)).toBe(false)
          expect(supervisor.list()[0]!.status.state).toBe("stopped")
        })
      )
    )
  })

  test("autostart: false stays stopped until started", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([{ id: "lazy", cmd: LONG_RUNNER, autostart: false }])
          )
          expect(supervisor.list()[0]!.status.state).toBe("stopped")

          yield* supervisor.start("lazy")
          expect(supervisor.list()[0]!.status.state).toBe("running")
        })
      )
    )
  })

  test("a failing proc marks itself, not the supervisor", async () => {
    // A missing binary is not a sync spawn failure on macOS: node-pty spawns
    // its helper fine, and the exec fails inside it — the proc goes
    // running → exited(nonzero) within milliseconds. Wait for that.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              { id: "broken", cmd: ["definitely-not-a-real-binary-xyz"] },
              { id: "fine", cmd: LONG_RUNNER }
            ])
          )
          const subscription = yield* Stream.toQueue(supervisor.events, { capacity: "unbounded" })
          const exited = yield* takeUntil(
            subscription,
            (event) =>
              event.type === "status" &&
              event.status.id === "broken" &&
              event.status.state === "exited"
          )
          expect(exited.type === "status" && exited.status.exitCode).not.toBe(0)

          const fine = supervisor.list().find((info) => info.id === "fine")!
          expect(fine.status.state).toBe("running")
        })
      )
    )
  })

  test("detects listening ports of the tree", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              {
                id: "server",
                cmd: [
                  "node",
                  "-e",
                  'const s = require("net").createServer(); s.listen(0, () => console.log("PORT:" + s.address().port));'
                ]
              }
            ])
          )
          const subscription = yield* Stream.toQueue(supervisor.events, { capacity: "unbounded" })

          // Learn the actual port from the child's own output…
          const logged = yield* takeUntil(
            subscription,
            (event) => event.type === "log" && event.data.includes("PORT:")
          )
          const port = Number(/PORT:(\d+)/.exec(logged.type === "log" ? logged.data : "")![1])

          // …and wait for the poll loop to discover the same port from the OS.
          yield* takeUntil(
            subscription,
            (event) => event.type === "status" && (event.status.ports ?? []).includes(port)
          )
        })
      )
    )
  })

  test("a pinned port is the public assigned port, with the observer in front", async () => {
    const [pin] = await findFreePorts(1)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              {
                id: "api",
                cmd: [
                  "node",
                  "-e",
                  'require("http").createServer((req, res) => res.end("pinned-ok")).listen(process.env.PORT)'
                ],
                env: { PORT: "${port}" },
                port: pin
              }
            ])
          )
          expect(supervisor.list()[0]!.assignedPort).toBe(pin)
          // No `url` in the spec — the UI link is derived from the pin.
          expect(supervisor.list()[0]!.url).toBe(`http://localhost:${pin}`)

          // The pin answers through the observer while the proc itself binds a
          // hidden internal port — so the exchange must also get captured.
          const body = yield* Effect.promise(async () => {
            for (let attempt = 0; attempt < 50; attempt++) {
              const answer = await fetch(`http://127.0.0.1:${pin!}/hello`)
                .then((res) => (res.ok ? res.text() : undefined))
                .catch(() => undefined)
              if (answer !== undefined) return answer
              await new Promise((resolve) => setTimeout(resolve, 100))
            }
            return undefined
          })
          expect(body).toBe("pinned-ok")
          const captured = supervisor.http({ procs: ["api"], limit: 10 })
          expect(captured.exchanges.map((e) => e.path)).toContain("/hello")
        })
      )
    )
  })

  test("a taken pin parks its proc in blocked; Start retries once the port is free", async () => {
    const [pin] = await findFreePorts(1)
    // Somebody else holds the pinned port — the same service started outside
    // procdeck, as far as the deck can tell.
    const holder = createNetServer()
    await new Promise<void>((resolve) => holder.listen(pin!, "127.0.0.1", resolve))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              {
                id: "api",
                cmd: [
                  "node",
                  "-e",
                  'require("http").createServer((req, res) => res.end("pinned-ok")).listen(process.env.PORT); setInterval(() => {}, 1000)'
                ],
                env: { PORT: "${port}" },
                port: pin
              },
              { id: "fine", cmd: LONG_RUNNER }
            ])
          )
          // Only the pinned proc is parked; the deck itself is up.
          const status = (id: string) => supervisor.list().find((info) => info.id === id)!.status
          expect(status("api").state).toBe("blocked")
          expect(status("api").hint).toContain(`:${pin}`)
          expect(status("fine").state).toBe("running")

          // Starting while the port is still taken parks it again…
          yield* supervisor.start("api")
          expect(status("api").state).toBe("blocked")

          // …and once the holder lets go, Start binds the observer and spawns.
          yield* Effect.promise(() => new Promise<void>((resolve) => holder.close(() => resolve())))
          yield* supervisor.start("api")
          expect(status("api").state).toBe("running")
          const body = yield* Effect.promise(async () => {
            for (let attempt = 0; attempt < 50; attempt++) {
              const answer = await fetch(`http://127.0.0.1:${pin!}/retry`)
                .then((res) => (res.ok ? res.text() : undefined))
                .catch(() => undefined)
              if (answer !== undefined) return answer
              await new Promise((resolve) => setTimeout(resolve, 100))
            }
            return undefined
          })
          expect(body).toBe("pinned-ok")
        })
      )
    )
  })

  test("needs: dependent waits, then starts once the dep listens", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              {
                id: "api",
                // Listens only after a delay — the dependent must sit waiting.
                cmd: [
                  "node",
                  "-e",
                  'setTimeout(() => require("net").createServer().listen(0, () => console.log("listening")), 400); setInterval(() => {}, 1000)'
                ]
              },
              { id: "web", cmd: LONG_RUNNER, needs: ["api"] }
            ])
          )
          expect(supervisor.list().find((info) => info.id === "web")!.status.state).toBe("waiting")

          const subscription = yield* Stream.toQueue(supervisor.events, { capacity: "unbounded" })
          yield* takeUntil(
            subscription,
            (event) =>
              event.type === "status" &&
              event.status.id === "web" &&
              event.status.state === "running"
          )
          // The dep must have been listening by then.
          const api = supervisor.list().find((info) => info.id === "api")!
          expect(api.status.ports?.length).toBeGreaterThan(0)
        })
      )
    )
  })

  test("readyWhen started: dependent starts without any ports", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              { id: "watcher", cmd: LONG_RUNNER, readyWhen: "started" },
              { id: "web", cmd: LONG_RUNNER, needs: ["watcher"] }
            ])
          )
          const subscription = yield* Stream.toQueue(supervisor.events, { capacity: "unbounded" })
          yield* takeUntil(
            subscription,
            (event) =>
              event.type === "status" &&
              event.status.id === "web" &&
              event.status.state === "running"
          )
        })
      )
    )
  })

  test("stop interrupts a waiting proc", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              // Never listens → dependent waits forever unless stopped.
              { id: "silent", cmd: LONG_RUNNER },
              { id: "web", cmd: LONG_RUNNER, needs: ["silent"] }
            ])
          )
          expect(supervisor.list().find((info) => info.id === "web")!.status.state).toBe("waiting")
          yield* supervisor.stop("web")
          expect(supervisor.list().find((info) => info.id === "web")!.status.state).toBe("stopped")
        })
      )
    )
  })

  test("closing the scope terminates every process tree", async () => {
    const pids = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              { id: "one", cmd: LONG_RUNNER },
              // A tree with a grandchild, to prove the group kill on shutdown.
              { id: "two", shell: `node -e 'setInterval(() => {}, 1000)' & sleep 60` }
            ])
          )
          const pids = supervisor.list().map((info) => info.status.pid!)
          for (const pid of pids) expect(isGroupAlive(pid)).toBe(true)
          return pids
        })
      )
    )
    // The scope is closed — nothing may survive it.
    for (const pid of pids) expect(isGroupAlive(pid)).toBe(false)
  })

  test("backlog is per proc: a chatty neighbour cannot evict a quiet proc's history", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              {
                id: "quiet",
                cmd: ["node", "-e", 'console.log("quiet-hello"); setInterval(() => {}, 1000)']
              },
              {
                id: "chatty",
                // ~1 MB of output, far past the 256 KB per-proc budget.
                cmd: [
                  "node",
                  "-e",
                  'for (let i = 0; i < 8192; i++) console.log("x".repeat(127) + i)'
                ]
              }
            ])
          )
          // Wait for chatty to finish writing, then subscribe late.
          const first = yield* Stream.toQueue(supervisor.events, { capacity: "unbounded" })
          yield* takeUntil(
            first,
            (event) =>
              event.type === "status" &&
              event.status.id === "chatty" &&
              event.status.state === "exited"
          )
          yield* Effect.sleep("300 millis")

          const late = yield* Stream.toQueue(supervisor.events, { capacity: "unbounded" })
          const backlog: Array<ProcEvent> = []
          while (true) {
            const event = yield* Queue.take(late)
            if (event.type === "synced") break
            backlog.push(event)
          }
          const logsOf = (id: string) =>
            backlog.filter((event) => event.type === "log" && event.id === id) as Array<{
              type: "log"
              data: string
              seq: number
            }>
          // The quiet proc's line survived the neighbour's flood…
          expect(logsOf("quiet").some((event) => event.data.includes("quiet-hello"))).toBe(true)
          // …and the flood itself is bounded, keeping its tail.
          const chatty = logsOf("chatty")
          const bytes = chatty.reduce((sum, event) => sum + event.data.length, 0)
          expect(bytes).toBeLessThanOrEqual(256 * 1024 + 64 * 1024)
          expect(chatty.at(-1)!.data).toContain("8191")
          // Every proc's current status closes its backlog, and seqs are monotonic.
          expect(
            backlog.filter((event) => event.type === "status").map((e) => e.status.id)
          ).toEqual(["quiet", "chatty"])
          const seqs = chatty.map((event) => event.seq)
          expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
        })
      )
    )
  })

  test("no duplicate chunk at the backlog/live seam", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              {
                id: "ticker",
                cmd: ["node", "-e", "let i = 0; setInterval(() => console.log('tick ' + i++), 5)"]
              }
            ])
          )
          yield* Effect.sleep("200 millis")
          // Subscribe while it is talking, read for a while, check every seq once.
          const queue = yield* Stream.toQueue(supervisor.events, { capacity: "unbounded" })
          const seen: Array<number> = []
          let synced = false
          const deadline = Date.now() + 400
          while (Date.now() < deadline) {
            const event = yield* Queue.take(queue)
            if (event.type === "synced") synced = true
            if (event.type === "log") seen.push(event.seq)
          }
          expect(synced).toBe(true)
          expect(seen.length).toBeGreaterThan(10)
          expect(new Set(seen).size).toBe(seen.length)
          for (let i = 1; i < seen.length; i++) expect(seen[i]).toBe(seen[i - 1]! + 1)
        })
      )
    )
  })
})
