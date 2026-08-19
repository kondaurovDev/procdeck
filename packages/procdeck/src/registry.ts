import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import * as path from "node:path"

/**
 * The instance registry: one JSON file per running deck under
 * `~/.procdeck/instances/`. It is how `procdeck down|status|open|logs` find
 * the deck for the project they are run in, how `procdeck ls` and the UI's
 * deck switcher list every live deck, and it doubles as the pidfile.
 *
 * Plain files, no daemon: a deck writes its entry once it is listening and
 * removes it on shutdown; readers drop entries whose pid is gone, so a
 * crashed deck never lingers. `PROCDECK_HOME` relocates the whole tree
 * (tests, sandboxes).
 */
export type Instance = {
  /** Stable id derived from the root path — also the file and log name. */
  id: string
  /** Deck name (`name` in the config, else the root's basename). */
  name: string
  /** Directory of the config file; identifies the project. */
  root: string
  /** Path of the config file the deck was started from. */
  config: string
  port: number
  pid: number
  /** Where the deck's own stdout/stderr go (detached mode). */
  log: string
  startedAt: number
  version: string
  mode: "detached" | "foreground"
}

export const procdeckHome = (): string =>
  process.env["PROCDECK_HOME"] ?? path.join(homedir(), ".procdeck")

const instancesDir = (): string => path.join(procdeckHome(), "instances")
const logsDir = (): string => path.join(procdeckHome(), "logs")

/**
 * One canonical spelling of a project root, so the id never depends on how
 * the path was reached: `process.cwd()` hands out real paths while a config
 * argument may go through a symlink (macOS `/var` → `/private/var`).
 */
export const canonicalRoot = (root: string): string => {
  const absolute = path.resolve(root)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/** Same root → same id, whatever the deck is called today. */
export const instanceId = (root: string): string =>
  createHash("sha1").update(canonicalRoot(root)).digest("hex").slice(0, 12)

export const logPath = (root: string): string => path.join(logsDir(), `${instanceId(root)}.log`)

const entryPath = (id: string): string => path.join(instancesDir(), `${id}.json`)

/** Liveness by pid — signal 0 probes without delivering anything. */
export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    // EPERM = exists but owned by someone else; still alive.
    return (cause as NodeJS.ErrnoException).code === "EPERM"
  }
}

export const ensureHome = (): void => {
  mkdirSync(instancesDir(), { recursive: true })
  mkdirSync(logsDir(), { recursive: true })
}

export const register = (instance: Instance): void => {
  ensureHome()
  // Write-then-rename, so a concurrent reader never sees a torn file.
  const target = entryPath(instance.id)
  const temp = `${target}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(instance, null, 2))
  renameSync(temp, target)
}

/** Remove the entry — only if it is still ours (a newer deck may have re-registered). */
export const deregister = (id: string, pid: number = process.pid): void => {
  const current = readEntry(id)
  if (current !== undefined && current.pid !== pid) return
  rmSync(entryPath(id), { force: true })
}

const readEntry = (id: string): Instance | undefined => {
  try {
    return JSON.parse(readFileSync(entryPath(id), "utf8")) as Instance
  } catch {
    return undefined
  }
}

/** Every live deck. Entries whose process is gone are pruned on the way. */
export const listInstances = (): Array<Instance> => {
  const dir = instancesDir()
  if (!existsSync(dir)) return []
  const live: Array<Instance> = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue
    const entry = readEntry(file.slice(0, -".json".length))
    if (entry === undefined || !isAlive(entry.pid)) {
      rmSync(path.join(dir, file), { force: true })
      continue
    }
    live.push(entry)
  }
  return live.sort((a, b) => a.name.localeCompare(b.name) || a.port - b.port)
}

/** The live deck for a project root, if any. */
export const findInstance = (root: string): Instance | undefined => {
  const entry = readEntry(instanceId(root))
  if (entry === undefined) return undefined
  if (!isAlive(entry.pid)) {
    rmSync(entryPath(entry.id), { force: true })
    return undefined
  }
  return entry
}

/** The live deck holding a port — to explain EADDRINUSE in procdeck's own terms. */
export const findByPort = (port: number): Instance | undefined =>
  listInstances().find((instance) => instance.port === port)
