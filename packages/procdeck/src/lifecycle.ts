import { spawn } from "node:child_process"
import { existsSync, openSync, readFileSync } from "node:fs"
import { createServer } from "node:net"
import { homedir } from "node:os"
import { ensureHome, findInstance, isAlive, logPath } from "./registry.ts"
import type { Instance } from "./registry.ts"

/**
 * Detached mode: `procdeck up` re-spawns itself as `up --fg` in its own
 * session with stdout/stderr in a log file and lets go of it. The child
 * registers itself once it is listening; that registry entry is how the
 * parent learns the deck came up — so "up" returns only when the UI is
 * reachable, and a bad config or a busy port surfaces here, in the terminal.
 */
export const detach = (
  cliPath: string,
  configPath: string,
  root: string,
): Promise<Instance> => {
  ensureHome()
  const log = openSync(logPath(root), "a")
  const child = spawn(
    process.execPath,
    [...process.execArgv, cliPath, "up", "--fg", "--no-open", configPath],
    {
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, PROCDECK_DETACHED: "1" },
      cwd: root,
    },
  )
  child.unref()

  const TIMEOUT_MS = 20_000
  const POLL_MS = 100
  return new Promise<Instance>((resolve, reject) => {
    const started = Date.now()
    const finish = (outcome: () => void) => {
      clearInterval(timer)
      child.removeListener("exit", onExit)
      outcome()
    }
    const onExit = (code: number | null) =>
      finish(() =>
        reject(new Error(`procdeck exited with code ${String(code)}${logTail(root, 15)}`)),
      )
    child.once("exit", onExit)
    const timer = setInterval(() => {
      const instance = findInstance(root)
      if (instance !== undefined && instance.pid === child.pid) {
        finish(() => resolve(instance))
      } else if (Date.now() - started > TIMEOUT_MS) {
        finish(() => reject(new Error(`procdeck did not come up in 20s${logTail(root, 15)}`)))
      }
    }, POLL_MS)
  })
}

/**
 * Stop a deck: SIGTERM (the same path as Ctrl-C — the supervisor tears every
 * tree down, then deregisters), and wait for the process to be gone. Past the
 * deadline it is SIGKILLed; its registry entry is stale then and pruned on
 * the next read.
 */
export const shutdown = async (instance: Instance): Promise<"stopped" | "killed"> => {
  const DEADLINE_MS = 30_000
  const POLL_MS = 100
  try {
    process.kill(instance.pid, "SIGTERM")
  } catch {
    return "stopped"
  }
  const started = Date.now()
  while (isAlive(instance.pid)) {
    if (Date.now() - started > DEADLINE_MS) {
      try {
        process.kill(instance.pid, "SIGKILL")
      } catch {
        // Gone in the meantime.
      }
      return "killed"
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return "stopped"
}

/** Open a URL in the default browser — best effort, never blocks, never throws. */
export const openBrowser = (url: string): void => {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open"
  const child = spawn(command, [url], { detached: true, stdio: "ignore" })
  child.on("error", () => {})
  child.unref()
}

/** Can the UI port be bound right now? (The same bind the server will do.) */
export const isPortFree = (port: number, host: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer()
    probe.once("error", () => resolve(false))
    probe.listen(port, host, () => probe.close(() => resolve(true)))
  })

/** Last `lines` lines of a deck's log (stack frames dropped), for a terminal message. */
export const logTail = (root: string, lines: number): string => {
  const file = logPath(root)
  if (!existsSync(file)) return ""
  const tail = readFileSync(file, "utf8")
    .trimEnd()
    .split("\n")
    .filter((line) => !/^\s+at /.test(line))
    .slice(-lines)
  return tail.length === 0 ? "" : `\n  ${pretty(file)}:\n  ${tail.join("\n  ")}`
}

/** `/Users/me/.procdeck/...` → `~/.procdeck/...` for terminal output. */
export const pretty = (file: string): string => {
  const home = homedir()
  return file.startsWith(home) ? `~${file.slice(home.length)}` : file
}
