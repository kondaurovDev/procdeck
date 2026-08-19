import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import * as path from "node:path"

/**
 * `procdeck init`: a first config from what the project already says about
 * itself. One proc per workspace package with a `dev` script (a plain
 * package gets one proc for its own `dev`), each run through the package
 * manager the lockfile points at. No ports are guessed — `${port}` only
 * helps when the script honours `PORT`, and that is the user's call.
 */

export type PackageManager = "pnpm" | "yarn" | "npm" | "bun"

type Package = {
  /** Directory relative to the root ("." for the root package). */
  dir: string
  name: string
  scripts: Record<string, string>
}

/** Scripts worth a pane, in order of preference. */
const DEV_SCRIPTS = ["dev", "start:dev", "serve", "watch", "start"] as const

const readPackage = (root: string, dir: string): Package | undefined => {
  const file = path.join(root, dir, "package.json")
  if (!existsSync(file)) return undefined
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as {
      name?: string
      scripts?: Record<string, string>
      workspaces?: Array<string> | { packages?: Array<string> }
    }
    return {
      dir,
      name: json.name ?? path.basename(path.resolve(root, dir)),
      scripts: json.scripts ?? {},
    }
  } catch {
    return undefined
  }
}

export const detectPackageManager = (root: string): PackageManager => {
  if (existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(path.join(root, "yarn.lock"))) return "yarn"
  if (existsSync(path.join(root, "bun.lockb")) || existsSync(path.join(root, "bun.lock"))) {
    return "bun"
  }
  return "npm"
}

/**
 * Workspace globs — `packages/*`, `apps/**`, `tools/cli` — expanded one level
 * deep: that is what the overwhelming majority of workspaces use, and a
 * wrong guess is one line to fix in the generated file.
 */
const expandGlob = (root: string, pattern: string): Array<string> => {
  const clean = pattern.replace(/\/\*\*?$/, "")
  const wildcard = clean !== pattern
  if (!wildcard) return existsSync(path.join(root, clean)) ? [clean] : []
  const base = path.join(root, clean)
  if (!existsSync(base) || !statSync(base).isDirectory()) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(clean, entry.name))
    .sort()
}

/** The `packages:` list of pnpm-workspace.yaml — a flat YAML list, read by hand. */
const pnpmWorkspaceGlobs = (root: string): Array<string> | undefined => {
  const file = path.join(root, "pnpm-workspace.yaml")
  if (!existsSync(file)) return undefined
  const globs: Array<string> = []
  let inPackages = false
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd()
    if (/^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (inPackages) {
      const item = /^\s+-\s*["']?([^"']+?)["']?\s*$/.exec(line)
      if (item) globs.push(item[1]!)
      else if (line.trim() !== "") inPackages = false
    }
  }
  return globs
}

const workspaceGlobs = (root: string): Array<string> => {
  const pnpm = pnpmWorkspaceGlobs(root)
  if (pnpm !== undefined) return pnpm
  const file = path.join(root, "package.json")
  if (!existsSync(file)) return []
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as {
      workspaces?: Array<string> | { packages?: Array<string> }
    }
    const workspaces = json.workspaces
    return Array.isArray(workspaces) ? workspaces : (workspaces?.packages ?? [])
  } catch {
    return []
  }
}

const devScript = (pkg: Package): string | undefined =>
  DEV_SCRIPTS.find((script) => pkg.scripts[script] !== undefined)

/** `pnpm --filter web dev` / `yarn workspace web dev` / `npm run dev -w web` / `bun run --filter web dev` */
const workspaceCommand = (pm: PackageManager, pkg: Package, script: string): string => {
  switch (pm) {
    case "pnpm":
      return `pnpm --filter ${pkg.name} ${script}`
    case "yarn":
      return `yarn workspace ${pkg.name} ${script}`
    case "bun":
      return `bun run --filter ${pkg.name} ${script}`
    case "npm":
      return `npm run ${script} -w ${pkg.name}`
  }
}

const rootCommand = (pm: PackageManager, script: string): string =>
  pm === "npm" ? `npm run ${script}` : `${pm} run ${script}`

/** A pane id: the package name without scope, unique within the deck. */
const paneId = (name: string, taken: Set<string>): string => {
  const base = name.replace(/^@[^/]+\//, "").replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "app"
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  taken.add(id)
  return id
}

export type InitPlan = {
  config: {
    $schema: string
    name: string
    procs: Array<{ id: string; shell: string }>
  }
  /** What was found, one line per proc, for the terminal. */
  notes: Array<string>
}

export const planInit = (root: string): InitPlan => {
  const pm = detectPackageManager(root)
  const name = readPackage(root, ".")?.name?.replace(/^@[^/]+\//, "") ?? path.basename(root)
  const procs: InitPlan["config"]["procs"] = []
  const notes: Array<string> = []
  const taken = new Set<string>()

  const globs = workspaceGlobs(root)
  const dirs = [...new Set(globs.filter((g) => !g.startsWith("!")).flatMap((g) => expandGlob(root, g)))]
  for (const dir of dirs) {
    const pkg = readPackage(root, dir)
    if (pkg === undefined) continue
    const script = devScript(pkg)
    if (script === undefined) continue
    const id = paneId(pkg.name, taken)
    procs.push({ id, shell: workspaceCommand(pm, pkg, script) })
    notes.push(`${id.padEnd(16)} ${dir}  (${script})`)
  }

  if (procs.length === 0) {
    const pkg = readPackage(root, ".")
    const script = pkg === undefined ? undefined : devScript(pkg)
    if (pkg !== undefined && script !== undefined) {
      const id = paneId(pkg.name, taken)
      procs.push({ id, shell: rootCommand(pm, script) })
      notes.push(`${id.padEnd(16)} .  (${script})`)
    }
  }

  if (procs.length === 0) {
    // Nothing to go on — a template that runs, to be edited.
    procs.push({ id: "app", shell: "echo 'edit procdeck.config.json'; sleep 1000" })
    notes.push("no package.json dev scripts found — wrote a template to edit")
  }

  return {
    config: { $schema: "https://unpkg.com/procdeck/schema.json", name, procs },
    notes,
  }
}
