import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import { Effect, PubSub } from "effect"
import type { LoadedConfig } from "../src/config.ts"
import type { ProcEvent } from "../src/events.ts"
import { makeSupervisor } from "../src/supervisor.ts"

/**
 * Integration tests for the "trust, but verify" layer added after the wrangler
 * login incident: preflight checks, url-pinned readiness and log alerts. Real
 * processes throughout — the risks live at the OS boundary.
 */

const loaded = (procs: LoadedConfig["config"]["procs"]): LoadedConfig => ({
  config: { procs },
  root: process.cwd(),
  name: "test",
})

const LONG_RUNNER = ["node", "-e", 'console.log("up"); setInterval(() => {}, 1000)']

const takeUntil = Effect.fn("takeUntil")(function* (
  subscription: PubSub.Subscription<ProcEvent>,
  predicate: (event: ProcEvent) => boolean,
) {
  while (true) {
    const event = yield* PubSub.take(subscription)
    if (predicate(event)) return event
  }
})

/** Grab a port the OS considers free right now. */
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const server = net.createServer()
    server.listen(0, () => {
      const port = (server.address() as net.AddressInfo).port
      server.close(() => resolve(port))
    })
  })

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "procdeck-test-"))
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }))

describe("preflight", () => {
  test("a passing preflight spawns the proc", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([{ id: "ok", cmd: LONG_RUNNER, preflight: { shell: "true" } }]),
          )
          const subscription = yield* PubSub.subscribe(supervisor.events)
          yield* takeUntil(
            subscription,
            (event) =>
              event.type === "status" && event.status.id === "ok" && event.status.state === "running",
          )
        }),
      ),
    )
  })

  test("a failing preflight blocks the proc and shows output + hint", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              {
                id: "gated",
                cmd: LONG_RUNNER,
                preflight: {
                  shell: "echo not-logged-in >&2; false",
                  hint: "run pnpm cloudflare:login",
                },
              },
            ]),
          )
          const subscription = yield* PubSub.subscribe(supervisor.events)
          // The check's output and the hint both land in the pane log (they
          // arrive in one chunk, before the status flips — a single predicate,
          // because each take consumes the event for good).
          yield* takeUntil(
            subscription,
            (event) =>
              event.type === "log" &&
              event.data.includes("not-logged-in") &&
              event.data.includes("run pnpm cloudflare:login"),
          )
          yield* takeUntil(
            subscription,
            (event) =>
              event.type === "status" &&
              event.status.id === "gated" &&
              event.status.state === "blocked",
          )
          expect(
            supervisor.list().find((entry) => entry.id === "gated")!.status.hint,
          ).toBe("run pnpm cloudflare:login")
          // The process was never spawned.
          const info = supervisor.list().find((entry) => entry.id === "gated")!
          expect(info.status.pid).toBeUndefined()
        }),
      ),
    )
  })

  test("a blocked proc never becomes ready for dependents", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              { id: "gated", cmd: LONG_RUNNER, preflight: { shell: "false" } },
              { id: "web", cmd: LONG_RUNNER, needs: ["gated"] },
            ]),
          )
          const subscription = yield* PubSub.subscribe(supervisor.events)
          yield* takeUntil(
            subscription,
            (event) =>
              event.type === "status" &&
              event.status.id === "gated" &&
              event.status.state === "blocked",
          )
          expect(supervisor.list().find((entry) => entry.id === "web")!.status.state).toBe(
            "waiting",
          )
        }),
      ),
    )
  })

  test("expect: exit 0 without the expected output still blocks", async () => {
    // The `wrangler whoami` case: the check exits 0 either way, and only its
    // output tells authenticated from not.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              {
                id: "gated",
                cmd: LONG_RUNNER,
                preflight: { shell: "echo you are NOT logged in", expect: "You are logged in" },
              },
              {
                id: "ok",
                cmd: LONG_RUNNER,
                preflight: { shell: "echo You are logged in as x", expect: "You are logged in" },
              },
            ]),
          )
          const subscription = yield* PubSub.subscribe(supervisor.events)
          yield* takeUntil(
            subscription,
            (event) =>
              event.type === "status" &&
              event.status.id === "gated" &&
              event.status.state === "blocked",
          )
          yield* takeUntil(
            subscription,
            (event) =>
              event.type === "status" && event.status.id === "ok" && event.status.state === "running",
          )
        }),
      ),
    )
  })

  test("start() retries the preflight; once it passes the proc runs", async () => {
    const flag = path.join(tmpDir, "logged-in")
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              { id: "gated", cmd: LONG_RUNNER, preflight: { shell: `test -f ${flag}` } },
            ]),
          )
          const subscription = yield* PubSub.subscribe(supervisor.events)
          yield* takeUntil(
            subscription,
            (event) =>
              event.type === "status" &&
              event.status.id === "gated" &&
              event.status.state === "blocked",
          )

          writeFileSync(flag, "")
          yield* supervisor.start("gated")
          yield* takeUntil(
            subscription,
            (event) =>
              event.type === "status" &&
              event.status.id === "gated" &&
              event.status.state === "running",
          )
        }),
      ),
    )
  })
})

describe("url-pinned readiness", () => {
  test("a stray port does not satisfy readiness when url names another", async () => {
    const urlPort = await freePort()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              {
                // Listens on a random port — think wrangler's login server on
                // :8976 — while the url promises `urlPort`.
                id: "api",
                cmd: [
                  "node",
                  "-e",
                  'require("net").createServer().listen(0, () => console.log("stray-up")); setInterval(() => {}, 1000)',
                ],
                url: `http://localhost:${urlPort}`,
              },
              { id: "web", cmd: LONG_RUNNER, needs: ["api"] },
            ]),
          )
          const subscription = yield* PubSub.subscribe(supervisor.events)
          // Wait until the poll loop has seen the stray port…
          yield* takeUntil(
            subscription,
            (event) =>
              event.type === "status" &&
              event.status.id === "api" &&
              (event.status.ports ?? []).length > 0,
          )
          // …and the dependent must still be waiting.
          expect(supervisor.list().find((entry) => entry.id === "web")!.status.state).toBe(
            "waiting",
          )
        }),
      ),
    )
  })

  test("readiness opens once the url's own port is bound", async () => {
    const urlPort = await freePort()
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
                  `require("net").createServer().listen(${urlPort}, () => console.log("api-up")); setInterval(() => {}, 1000)`,
                ],
                url: `http://localhost:${urlPort}`,
              },
              { id: "web", cmd: LONG_RUNNER, needs: ["api"] },
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
})

describe("log alerts", () => {
  test("a matching pattern raises the alert on the status", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              {
                id: "chatty",
                cmd: [
                  "node",
                  "-e",
                  'console.log("Opening a link in your default browser"); setInterval(() => {}, 1000)',
                ],
                alerts: [{ pattern: "Opening a link", label: "needs login" }],
              },
            ]),
          )
          const subscription = yield* PubSub.subscribe(supervisor.events)
          yield* takeUntil(
            subscription,
            (event) => event.type === "status" && event.status.alert === "needs login",
          )
        }),
      ),
    )
  })

  test("a restart clears the alert", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const supervisor = yield* makeSupervisor(
            loaded([
              {
                id: "chatty",
                cmd: ["node", "-e", 'console.log("ALERT-ME"); setInterval(() => {}, 1000)'],
                alerts: [{ pattern: "ALERT-ME", label: "attention" }],
              },
            ]),
          )
          const subscription = yield* PubSub.subscribe(supervisor.events)
          yield* takeUntil(
            subscription,
            (event) => event.type === "status" && event.status.alert === "attention",
          )
          yield* supervisor.stop("chatty")
          expect(
            supervisor.list().find((entry) => entry.id === "chatty")!.status.alert,
          ).toBeUndefined()
        }),
      ),
    )
  })
})
