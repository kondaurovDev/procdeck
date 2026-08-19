export type ProcState = "stopped" | "waiting" | "starting" | "running" | "exited" | "blocked"

export type ProcStatus = {
  id: string
  state: ProcState
  pid?: number
  exitCode?: number
  /** Name of the signal that ended it ("SIGTERM"), when one did. */
  signal?: string
  /** Epoch ms of the last successful spawn. */
  startedAt?: number
  /** Epoch ms of the last exit (state "exited" only). */
  exitedAt?: number
  /** Spawns beyond the first since the deck came up — crash loops show here. */
  restarts?: number
  /** TCP ports the process tree is listening on (auto-detected). */
  ports?: Array<number>
  /** Why the proc is blocked — the preflight's hint (state "blocked" only). */
  hint?: string
  /** Label of a matched output alert, cleared on respawn. */
  alert?: string
}

/** Everything the server pushes to the browser over SSE. */
export type ProcEvent =
  | { type: "log"; id: string; data: string }
  | { type: "status"; status: ProcStatus }

/** Static description of a process, sent once on connect. */
export type ProcInfo = {
  id: string
  command: string
  url?: string
  /** Port procdeck assigned to this proc (specs using `${port}`). */
  assignedPort?: number
  /** Stable per-pane address served by the built-in reverse proxy. */
  proxyUrl?: string
  status: ProcStatus
}
