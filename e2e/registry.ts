import { createHash } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import * as path from "node:path"

/**
 * Read-only access to the instance registry the binary writes
 * (`$PROCDECK_HOME/instances/<id>.json`) — what the suites assert against
 * besides the CLI's own output.
 */
export type Instance = {
  id: string
  name: string
  root: string
  config: string
  port: number
  pid: number
  log: string
  startedAt: number
  version: string
  mode: "detached" | "foreground"
}

const home = (): string => process.env["PROCDECK_HOME"] ?? path.join(homedir(), ".procdeck")

const canonicalRoot = (root: string): string => {
  try {
    return realpathSync(path.resolve(root))
  } catch {
    return path.resolve(root)
  }
}

/** sha1 of the canonical root, first 12 hex chars — the entry's file name. */
export const instanceId = (root: string): string =>
  createHash("sha1").update(canonicalRoot(root)).digest("hex").slice(0, 12)

/** Liveness by pid; EPERM means it exists but belongs to someone else. */
export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The live deck for a project root, if any. */
export const findInstance = (root: string): Instance | undefined => {
  try {
    const file = path.join(home(), "instances", `${instanceId(root)}.json`)
    const entry = JSON.parse(readFileSync(file, "utf8")) as Instance
    return isAlive(entry.pid) ? entry : undefined
  } catch {
    return undefined
  }
}
