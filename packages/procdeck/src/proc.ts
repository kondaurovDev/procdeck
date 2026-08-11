import { execFile } from "node:child_process"
import { spawn } from "node-pty"
import type { IPty } from "node-pty"
import type { ProcSpec } from "./config.ts"

/**
 * Low-level PTY handling: spawn, signal delivery, process-tree teardown.
 *
 * Plain Node on purpose — the Effect layer sits on top of this in
 * `supervisor.ts`, so the tricky OS bits stay independently readable.
 */

export type SpawnedProc = {
  pty: IPty
  pid: number
  /** Resolves once the process (and its PTY) is gone. */
  exited: Promise<{ exitCode: number; signal?: number }>
}

export type SpawnOptions = {
  spec: ProcSpec
  /** Fallback cwd when the spec does not set one. */
  root: string
  cols: number
  rows: number
  onData: (data: string) => void
}

/** Human-readable command line, used as the UI subtitle. */
export const describeCommand = (spec: ProcSpec): string => spec.shell ?? (spec.cmd ?? []).join(" ")

const resolveArgv = (spec: ProcSpec): { file: string; args: Array<string> } => {
  if (spec.shell !== undefined) {
    return { file: process.env["SHELL"] ?? "/bin/sh", args: ["-c", spec.shell] }
  }
  const [file, ...args] = spec.cmd ?? []
  if (file === undefined) {
    throw new Error(`proc "${spec.id}" defines neither shell nor cmd`)
  }
  return { file, args }
}

const buildEnv = (spec: ProcSpec): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // A real PTY already implies a TTY, but some tools look at these directly.
  env["TERM"] = "xterm-256color"
  env["FORCE_COLOR"] = "1"
  return { ...env, ...spec.env }
}

export const spawnProc = (options: SpawnOptions): SpawnedProc => {
  const { spec, root, cols, rows, onData } = options
  const { file, args } = resolveArgv(spec)

  const pty = spawn(file, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: spec.cwd === undefined ? root : spec.cwd,
    env: buildEnv(spec),
  })

  pty.onData(onData)

  const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
    pty.onExit(({ exitCode, signal }) =>
      resolve(signal === undefined ? { exitCode } : { exitCode, signal }),
    )
  })

  return { pty, pid: pty.pid, exited }
}

/**
 * Run a preflight check: plain (non-PTY) shell command, combined output
 * captured for the pane. Exit 0 means "clear to spawn". A timeout counts as a
 * failure — a preflight that hangs is a preflight that failed.
 */
export const runPreflight = (
  shell: string,
  cwd: string,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; output: string }> =>
  new Promise((resolve) => {
    execFile(
      process.env["SHELL"] ?? "/bin/sh",
      ["-c", shell],
      { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ ok: error === null, output: `${stdout}${stderr}` })
      },
    )
  })

/**
 * Signal the whole process group.
 *
 * `forkpty` puts the child in a new session, so its pid doubles as the process
 * group id and a negative pid reaches every descendant — `pnpm` → `wrangler` →
 * `workerd`. Killing just the pid would leave the grandchildren holding ports.
 */
export const killTree = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal)
  } catch {
    // No such group (already reaped, or never became a leader): try the pid.
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone.
    }
  }
}

/**
 * Whether anything in the process group is still alive. Checking the group, not
 * the leader: `pnpm` may have died on its own while `wrangler`/`workerd` are
 * still running under the same pgid.
 */
export const isGroupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Stop a process tree: SIGTERM, a grace period, then SIGKILL for whatever is
 * still standing.
 */
export const terminate = async (proc: SpawnedProc, graceMs = 4000): Promise<void> => {
  if (!isGroupAlive(proc.pid)) return
  killTree(proc.pid, "SIGTERM")

  const timedOut = Symbol("timeout")
  const outcome = await Promise.race([proc.exited, delay(graceMs).then(() => timedOut)])

  // The leader exiting proves nothing about its descendants — workerd may have
  // ignored SIGTERM. Probe the whole group before declaring victory.
  if (outcome !== timedOut && !isGroupAlive(proc.pid)) return

  killTree(proc.pid, "SIGKILL")
  for (let i = 0; i < 10 && isGroupAlive(proc.pid); i++) {
    await delay(100)
  }
}
