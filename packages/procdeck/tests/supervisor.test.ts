import { describe, expect, test } from "vitest"
import { Effect, PubSub } from "effect"
import type { LoadedConfig } from "../src/config.ts"
import type { ProcEvent } from "../src/events.ts"
import { isGroupAlive } from "../src/proc.ts"
import { makeSupervisor } from "../src/supervisor.ts"

const loaded = (procs: LoadedConfig["config"]["procs"]): LoadedConfig => ({
  config: { procs },
  root: process.cwd(),
})

const LONG_RUNNER = ["node", "-e", 'console.log("up"); setInterval(() => {}, 1000)']

/** Pull events from a subscription until one satisfies the predicate. */
const takeUntil = Effect.fn("takeUntil")(function* (
  subscription: PubSub.Subscription<ProcEvent>,
  predicate: (event: ProcEvent) => boolean,
) {
  while (true) {
    const event = yield* PubSub.take(subscription)
    if (predicate(event)) return event
  }
})

describe("supervisor", () => {
  test("autostarts procs, streams logs, reports exit", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([{ id: "hello", cmd: ["node", "-e", 'console.log("hello-from-child")'] }]),
          )
          // Subscribing after the fact still sees the backlog: replay buffer.
          const subscription = yield* PubSub.subscribe(supervisor.events)
          yield* takeUntil(
            subscription,
            (event) => event.type === "log" && event.data.includes("hello-from-child"),
          )
          yield* takeUntil(
            subscription,
            (event) =>
              event.type === "status" &&
              event.status.state === "exited" &&
              event.status.exitCode === 0,
          )
        }),
      ),
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
        }),
      ),
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
        }),
      ),
    )
  })

  test("autostart: false stays stopped until started", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([{ id: "lazy", cmd: LONG_RUNNER, autostart: false }]),
          )
          expect(supervisor.list()[0]!.status.state).toBe("stopped")

          yield* supervisor.start("lazy")
          expect(supervisor.list()[0]!.status.state).toBe("running")
        }),
      ),
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
              { id: "fine", cmd: LONG_RUNNER },
            ]),
          )
          const subscription = yield* PubSub.subscribe(supervisor.events)
          const exited = yield* takeUntil(
            subscription,
            (event) =>
              event.type === "status" &&
              event.status.id === "broken" &&
              event.status.state === "exited",
          )
          expect(exited.type === "status" && exited.status.exitCode).not.toBe(0)

          const fine = supervisor.list().find((info) => info.id === "fine")!
          expect(fine.status.state).toBe("running")
        }),
      ),
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
                  'const s = require("net").createServer(); s.listen(0, () => console.log("PORT:" + s.address().port));',
                ],
              },
            ]),
          )
          const subscription = yield* PubSub.subscribe(supervisor.events)

          // Learn the actual port from the child's own output…
          const logged = yield* takeUntil(
            subscription,
            (event) => event.type === "log" && event.data.includes("PORT:"),
          )
          const port = Number(/PORT:(\d+)/.exec(logged.type === "log" ? logged.data : "")![1])

          // …and wait for the poll loop to discover the same port from the OS.
          yield* takeUntil(
            subscription,
            (event) => event.type === "status" && (event.status.ports ?? []).includes(port),
          )
        }),
      ),
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
                  'setTimeout(() => require("net").createServer().listen(0, () => console.log("listening")), 400); setInterval(() => {}, 1000)',
                ],
              },
              { id: "web", cmd: LONG_RUNNER, needs: ["api"] },
            ]),
          )
          expect(supervisor.list().find((info) => info.id === "web")!.status.state).toBe("waiting")

          const subscription = yield* PubSub.subscribe(supervisor.events)
          yield* takeUntil(
            subscription,
            (event) =>
              event.type === "status" &&
              event.status.id === "web" &&
              event.status.state === "running",
          )
          // The dep must have been listening by then.
          const api = supervisor.list().find((info) => info.id === "api")!
          expect(api.status.ports?.length).toBeGreaterThan(0)
        }),
      ),
    )
  })

  test("readyWhen started: dependent starts without any ports", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              { id: "watcher", cmd: LONG_RUNNER, readyWhen: "started" },
              { id: "web", cmd: LONG_RUNNER, needs: ["watcher"] },
            ]),
          )
          const subscription = yield* PubSub.subscribe(supervisor.events)
          yield* takeUntil(
            subscription,
            (event) =>
              event.type === "status" &&
              event.status.id === "web" &&
              event.status.state === "running",
          )
        }),
      ),
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
              { id: "web", cmd: LONG_RUNNER, needs: ["silent"] },
            ]),
          )
          expect(supervisor.list().find((info) => info.id === "web")!.status.state).toBe("waiting")
          yield* supervisor.stop("web")
          expect(supervisor.list().find((info) => info.id === "web")!.status.state).toBe("stopped")
        }),
      ),
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
              { id: "two", shell: `node -e 'setInterval(() => {}, 1000)' & sleep 60` },
            ]),
          )
          const pids = supervisor.list().map((info) => info.status.pid!)
          for (const pid of pids) expect(isGroupAlive(pid)).toBe(true)
          return pids
        }),
      ),
    )
    // The scope is closed — nothing may survive it.
    for (const pid of pids) expect(isGroupAlive(pid)).toBe(false)
  })
})
