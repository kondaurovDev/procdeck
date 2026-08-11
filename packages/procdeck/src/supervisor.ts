import { Effect, Fiber, Latch, PubSub } from "effect"
import type { Scope } from "effect"
import { DEFAULT_UI_PORT, resolveSpec, usesOwnPort } from "./config.ts"
import type { LoadedConfig, ProcSpec } from "./config.ts"
import type { ProcEvent, ProcInfo, ProcStatus } from "./events.ts"
import { describeCommand, runPreflight, spawnProc, terminate } from "./proc.ts"
import type { SpawnedProc } from "./proc.ts"
import { detectPorts, findFreePorts, isInternalPort, samePorts } from "./ports.ts"

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 30
const PORT_POLL_INTERVAL = "1 second"

/** Ring buffer of events; a fresh browser tab replays it and sees the backlog. */
const EVENT_BUFFER = 5000

type Runtime = {
  spec: ProcSpec
  /** The spec with `${port}` templates substituted — what actually spawns. */
  resolved: ProcSpec
  /** Free port assigned at startup, for specs that use `${port}`. */
  assignedPort: number | undefined
  status: ProcStatus
  proc: SpawnedProc | undefined
  /** Open once the proc is "ready" for dependents (see `readyWhen`). */
  ready: Latch.Latch
  /** Fiber waiting on `needs` before spawning; interrupted by stop(). */
  waiter: Fiber.Fiber<unknown> | undefined
  ports: Array<number>
  /** Rolling tail of recent output, matched against `alerts` patterns. */
  tail: string
  cols: number
  rows: number
}

/**
 * The port the spec's `url` promises, if any. Readiness keys on it: a tree can
 * open a port that is not the service — wrangler's OAuth callback server on
 * :8976 must not count as "the backend is up".
 */
const requiredPort = (spec: ProcSpec): number | undefined => {
  if (spec.url === undefined) return undefined
  try {
    const url = new URL(spec.url)
    return url.port === "" ? undefined : Number(url.port)
  } catch {
    return undefined
  }
}

/** How much recent output alert patterns are matched against. */
const ALERT_TAIL = 4096

export type Supervisor = {
  events: PubSub.PubSub<ProcEvent>
  list: () => Array<ProcInfo>
  start: (id: string) => Effect.Effect<void>
  stop: (id: string) => Effect.Effect<void>
  restart: (id: string) => Effect.Effect<void>
  resize: (id: string, cols: number, rows: number) => void
  write: (id: string, data: string) => void
  /**
   * Where the reverse proxy should send `<id>.localhost` traffic: the assigned
   * port, else the configured url's port, else the first non-internal port the
   * tree is listening on. `undefined` = nothing to proxy to right now.
   */
  proxyPort: (id: string) => number | undefined
}

const make = Effect.fn("procdeck.supervisor")(function* (loaded: LoadedConfig) {
  const scope = yield* Effect.scope
  const events = yield* PubSub.sliding<ProcEvent>({
    capacity: EVENT_BUFFER,
    replay: EVENT_BUFFER,
  })

  // Assign a free port to every spec that asks for one (`${port}`) before
  // anything spawns — the assignments stay stable for the supervisor's
  // lifetime, so `${port:other}` references and the proxy table never move.
  const wantsPort = loaded.config.procs.filter(usesOwnPort)
  const freePorts = yield* Effect.promise(() => findFreePorts(wantsPort.length))
  const assigned = new Map(wantsPort.map((spec, index) => [spec.id, freePorts[index]!]))

  const runtimes = new Map<string, Runtime>()
  for (const spec of loaded.config.procs) {
    const assignedPort = assigned.get(spec.id)
    const resolved = resolveSpec(spec, assigned)
    runtimes.set(spec.id, {
      spec,
      resolved:
        assignedPort === undefined
          ? resolved
          // The PaaS contract: the assigned port also arrives as `PORT`.
          : { ...resolved, env: { PORT: String(assignedPort), ...resolved.env } },
      assignedPort,
      status: { id: spec.id, state: "stopped" },
      proc: undefined,
      ready: Latch.makeUnsafe(false),
      waiter: undefined,
      ports: [],
      tail: "",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    })
  }

  // Published from PTY callbacks, so it has to work outside of an Effect.
  const emit = (event: ProcEvent) => {
    PubSub.publishUnsafe(events, event)
  }

  const setStatus = (runtime: Runtime, status: ProcStatus) => {
    runtime.status = status
    emit({ type: "status", status })
  }

  const require_ = (id: string): Runtime => {
    const runtime = runtimes.get(id)
    if (runtime === undefined) throw new Error(`unknown proc "${id}"`)
    return runtime
  }

  const markUnready = (runtime: Runtime) => {
    runtime.ready.closeUnsafe()
    runtime.ports = []
  }

  // Runs inside the PTY data callback: stream the chunk to the browser, then
  // match alert patterns against a rolling tail (a pattern may straddle chunk
  // boundaries). First match wins until the next spawn resets it.
  const handleData = (runtime: Runtime, data: string) => {
    emit({ type: "log", id: runtime.spec.id, data })
    const alerts = runtime.spec.alerts ?? []
    if (alerts.length === 0 || runtime.status.alert !== undefined) return
    runtime.tail = (runtime.tail + data).slice(-ALERT_TAIL)
    for (const alert of alerts) {
      if (new RegExp(alert.pattern).test(runtime.tail)) {
        setStatus(runtime, { ...runtime.status, alert: alert.label })
        return
      }
    }
  }

  const startSync = (runtime: Runtime) => {
    if (runtime.proc !== undefined) return
    setStatus(runtime, { id: runtime.spec.id, state: "starting" })
    markUnready(runtime)
    runtime.tail = ""

    // A spawn failure (bad cwd, missing binary) marks this one proc, never the
    // whole supervisor: the error lands in the pane like any other output.
    let proc: SpawnedProc
    try {
      proc = spawnProc({
        spec: runtime.resolved,
        root: loaded.root,
        cols: runtime.cols,
        rows: runtime.rows,
        onData: (data) => handleData(runtime, data),
      })
    } catch (cause) {
      emit({
        type: "log",
        id: runtime.spec.id,
        data: `\r\nprocdeck: spawn failed: ${String(cause)}\r\n`,
      })
      setStatus(runtime, { id: runtime.spec.id, state: "exited", exitCode: -1 })
      return
    }
    runtime.proc = proc

    // Procs that never listen are ready by virtue of running.
    if (runtime.spec.readyWhen === "started") runtime.ready.openUnsafe()

    setStatus(runtime, {
      id: runtime.spec.id,
      state: "running",
      pid: proc.pid,
      startedAt: Date.now(),
    })

    void proc.exited.then(({ exitCode, signal }) => {
      // A restart swaps `runtime.proc` before the old exit lands; ignore stale ones.
      if (runtime.proc !== proc) return
      runtime.proc = undefined
      markUnready(runtime)
      setStatus(runtime, {
        id: runtime.spec.id,
        state: "exited",
        exitCode,
        ...(signal === undefined ? {} : { signal }),
      })
    })
  }

  // Preflight gate: run the check, and either clear the proc for spawning or
  // park it in "blocked" with the check's output and the hint in the pane.
  const gate = Effect.fn("procdeck.preflight")(function* (runtime: Runtime) {
    const preflight = runtime.spec.preflight
    if (preflight === undefined) return true
    setStatus(runtime, { id: runtime.spec.id, state: "starting" })
    const result = yield* Effect.promise(() =>
      runPreflight(preflight.shell, runtime.spec.cwd ?? loaded.root),
    )
    const expected =
      preflight.expect === undefined || new RegExp(preflight.expect).test(result.output)
    if (result.ok && expected) return true

    const reason = result.ok ? ` (output lacks /${preflight.expect}/)` : ""
    const lines = [
      `procdeck: preflight failed${reason}: ${preflight.shell}`,
      ...result.output.split("\n").filter((line) => line.length > 0),
      ...(preflight.hint === undefined ? [] : [`procdeck: hint: ${preflight.hint}`]),
    ]
    emit({ type: "log", id: runtime.spec.id, data: `\r\n${lines.join("\r\n")}\r\n` })
    // The launch attempt is over the moment "blocked" becomes visible — and an
    // observer may react with start() instantly, so the waiter slot must be
    // free before the event goes out (the fiber's own cleanup runs later).
    runtime.waiter = undefined
    setStatus(runtime, {
      id: runtime.spec.id,
      state: "blocked",
      ...(preflight.hint === undefined ? {} : { hint: preflight.hint }),
    })
    return false
  })

  const start = Effect.fn("procdeck.start")(function* (id: string) {
    const runtime = require_(id)
    if (runtime.proc !== undefined || runtime.waiter !== undefined) return

    const needs = runtime.spec.needs ?? []
    if (needs.length === 0 && runtime.spec.preflight === undefined) {
      return yield* Effect.sync(() => startSync(runtime))
    }

    // Declarative ordering: park in "waiting" until every dependency's ready
    // latch opens, then run the preflight gate, then spawn. The fiber lives in
    // the supervisor scope and is interrupted by stop()/shutdown.
    if (needs.length > 0) setStatus(runtime, { id: runtime.spec.id, state: "waiting" })
    let finished = false
    // The cleanup may run after a newer launch already claimed the waiter slot
    // (gate frees it early on "blocked") — only clear our own fiber.
    let self: Fiber.Fiber<unknown> | undefined
    const fiber = yield* Effect.forkIn(
      Effect.forEach(needs, (need) => require_(need).ready.await, { discard: true }).pipe(
        Effect.andThen(gate(runtime)),
        Effect.andThen((cleared) => Effect.sync(() => cleared && startSync(runtime))),
        Effect.ensuring(
          Effect.sync(() => {
            finished = true
            if (runtime.waiter === self) runtime.waiter = undefined
          }),
        ),
      ),
      scope,
    )
    self = fiber
    if (!finished) runtime.waiter = fiber
  })

  const stop = Effect.fn("procdeck.stop")(function* (id: string) {
    const runtime = require_(id)

    const waiter = runtime.waiter
    if (waiter !== undefined) {
      runtime.waiter = undefined
      yield* Fiber.interrupt(waiter)
      setStatus(runtime, { id: runtime.spec.id, state: "stopped" })
      return
    }

    const proc = runtime.proc
    if (proc === undefined) return
    runtime.proc = undefined
    markUnready(runtime)
    yield* Effect.promise(() => terminate(proc))
    if (runtime.status.state !== "exited") {
      setStatus(runtime, { id: runtime.spec.id, state: "stopped" })
    }
  })

  const restart = Effect.fn("procdeck.restart")(function* (id: string) {
    yield* stop(id)
    yield* start(id)
  })

  // One loop for every running proc: ask the OS which TCP ports the process
  // group is listening on; a non-empty answer is the default readiness signal.
  const pollPorts = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(PORT_POLL_INTERVAL)
      for (const runtime of runtimes.values()) {
        const proc = runtime.proc
        if (proc === undefined) continue
        const ports = yield* Effect.promise(() => detectPorts(proc.pid))
        if (runtime.proc !== proc) continue // exited while we were looking
        if (!samePorts(ports, runtime.ports)) {
          runtime.ports = ports
          setStatus(runtime, { ...runtime.status, ports })
        }
        if (runtime.spec.readyWhen !== "started") {
          // With a url or an assigned port, only that port counts — see `requiredPort`.
          const required = requiredPort(runtime.resolved) ?? runtime.assignedPort
          const ready = required === undefined ? ports.length > 0 : ports.includes(required)
          if (ready) runtime.ready.openUnsafe()
        }
      }
    }
  })
  yield* Effect.forkIn(pollPorts, scope)

  const uiPort = loaded.config.port ?? DEFAULT_UI_PORT

  const supervisor: Supervisor = {
    events,
    list: () =>
      [...runtimes.values()].map((runtime) => ({
        id: runtime.spec.id,
        command: describeCommand(runtime.resolved),
        ...(runtime.resolved.url === undefined ? {} : { url: runtime.resolved.url }),
        ...(runtime.assignedPort === undefined ? {} : { assignedPort: runtime.assignedPort }),
        proxyUrl: `http://${runtime.spec.id}.localhost:${uiPort}`,
        status: runtime.status,
      })),
    start,
    stop,
    restart,
    resize: (id, cols, rows) => {
      const runtime = runtimes.get(id)
      if (runtime === undefined || cols <= 0 || rows <= 0) return
      runtime.cols = cols
      runtime.rows = rows
      try {
        runtime.proc?.pty.resize(cols, rows)
      } catch {
        // Process died between the check and the resize.
      }
    },
    write: (id, data) => {
      runtimes.get(id)?.proc?.pty.write(data)
    },
    proxyPort: (id) => {
      const runtime = runtimes.get(id)
      if (runtime === undefined) return undefined
      return (
        runtime.assignedPort ??
        requiredPort(runtime.resolved) ??
        runtime.ports.find((port) => !isInternalPort(port))
      )
    },
  }

  const stopAll = Effect.forEach([...runtimes.keys()], stop, {
    concurrency: "unbounded",
    discard: true,
  })

  for (const runtime of runtimes.values()) {
    if (runtime.spec.autostart !== false) yield* start(runtime.spec.id)
  }

  return { supervisor, stopAll }
})

/**
 * Scoped supervisor: every process it spawned is torn down when the scope
 * closes — including on Ctrl-C or an unhandled failure upstream.
 */
export const makeSupervisor = (
  loaded: LoadedConfig,
): Effect.Effect<Supervisor, never, Scope.Scope> =>
  Effect.acquireRelease(make(loaded), ({ stopAll }) => stopAll).pipe(
    Effect.map(({ supervisor }) => supervisor),
  )
