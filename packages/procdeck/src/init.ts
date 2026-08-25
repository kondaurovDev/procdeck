import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import * as path from "node:path"

/**
 * `procdeck init`: a first config from what the project already says about
 * itself, tried in this order:
 *
 * 1. a `Procfile` — already a list of processes;
 * 2. workspaces (pnpm-workspace.yaml, `workspaces` in package.json) — one
 *    proc per package with a dev script, via the lockfile's package manager;
 * 3. plain subdirectories (`backend/`, `frontend/` — no workspace declared)
 *    — each with its own package.json dev script (its own lockfile decides
 *    the manager) or a recognisable non-JS project (Django, Go, Rust, Rails,
 *    docker compose), run with `cwd` set to that directory;
 * 4. the root itself — its package.json dev script or a non-JS marker;
 * 5. a template that runs, to be edited.
 *
 * No ports are guessed — `${port}` only helps when the command honours
 * `PORT`, and that is the user's call.
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
      scripts: json.scripts ?? {}
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
  const base =
    name
      .replace(/^@[^/]+\//, "")
      .replace(/[^a-z0-9-]/gi, "-")
      .toLowerCase() || "app"
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  taken.add(id)
  return id
}

export type InitProc = { id: string; shell: string; cwd?: string }

export type InitPlan = {
  config: {
    $schema: string
    name: string
    procs: Array<InitProc>
  }
  /** What was found, one line per proc, for the terminal. */
  notes: Array<string>
  /** Which detector produced the procs. */
  source: "Procfile" | "workspaces" | "subdirectories" | "root" | "template"
}

/**
 * Non-JS projects we can name a dev command for. Only markers that imply one
 * obvious command; everything else is left to the user.
 */
const NON_JS_MARKERS: Array<{ file: string; shell: string; what: string }> = [
  { file: "manage.py", shell: "python manage.py runserver", what: "Django" },
  { file: "bin/rails", shell: "bin/rails server", what: "Rails" },
  { file: "go.mod", shell: "go run .", what: "Go" },
  { file: "Cargo.toml", shell: "cargo run", what: "Rust" },
  { file: "mix.exs", shell: "mix phx.server", what: "Phoenix" },
  { file: "docker-compose.yml", shell: "docker compose up", what: "docker compose" },
  { file: "docker-compose.yaml", shell: "docker compose up", what: "docker compose" },
  { file: "compose.yaml", shell: "docker compose up", what: "docker compose" },
  { file: "compose.yml", shell: "docker compose up", what: "docker compose" }
]

const nonJsCommand = (dir: string): { shell: string; what: string } | undefined => {
  const marker = NON_JS_MARKERS.find((candidate) => existsSync(path.join(dir, candidate.file)))
  // Phoenix only if it is one — `mix.exs` alone could be any Elixir app.
  if (marker?.what === "Phoenix") {
    const mix = readFileSync(path.join(dir, "mix.exs"), "utf8")
    if (!mix.includes(":phoenix")) return undefined
  }
  return marker === undefined ? undefined : { shell: marker.shell, what: marker.what }
}

/** `name: command` per line — the Heroku/foreman format. */
const procfile = (root: string): Array<{ id: string; shell: string }> | undefined => {
  const file = path.join(root, "Procfile")
  if (!existsSync(file)) return undefined
  const procs: Array<{ id: string; shell: string }> = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$/.exec(line)
    if (match && !line.trimStart().startsWith("#")) procs.push({ id: match[1]!, shell: match[2]! })
  }
  return procs.length === 0 ? undefined : procs
}

/** Directories worth looking into for a sub-project, in name order. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "vendor", "target", "coverage", "tmp"])
const subdirectories = (root: string): Array<string> =>
  readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)
    )
    .map((entry) => entry.name)
    .sort()

/** What one directory would run: its package.json dev script, else a non-JS marker. */
const projectIn = (
  root: string,
  dir: string,
  fallbackPm: PackageManager
): { name: string; shell: string; what: string } | undefined => {
  const pkg = readPackage(root, dir)
  const script = pkg === undefined ? undefined : devScript(pkg)
  if (pkg !== undefined && script !== undefined) {
    // The directory's own lockfile wins; otherwise the root's (or npm).
    const here = path.join(root, dir)
    const pm = existsSync(path.join(here, "package.json")) ? detectPackageManager(here) : fallbackPm
    const ownLock = pm !== "npm" || existsSync(path.join(here, "package-lock.json"))
    return { name: pkg.name, shell: rootCommand(ownLock ? pm : fallbackPm, script), what: script }
  }
  const nonJs = nonJsCommand(path.join(root, dir))
  if (nonJs !== undefined) {
    return { name: path.basename(path.resolve(root, dir)), shell: nonJs.shell, what: nonJs.what }
  }
  return undefined
}

export const planInit = (root: string): InitPlan => {
  const pm = detectPackageManager(root)
  const name = readPackage(root, ".")?.name?.replace(/^@[^/]+\//, "") ?? path.basename(root)
  const taken = new Set<string>()
  const done = (
    procs: Array<InitProc>,
    notes: Array<string>,
    source: InitPlan["source"]
  ): InitPlan => ({
    config: { $schema: "https://unpkg.com/procdeck/schema.json", name, procs },
    notes,
    source
  })

  // 1. Procfile: somebody already wrote the list.
  const declared = procfile(root)
  if (declared !== undefined) {
    return done(
      declared.map((proc) => ({ id: paneId(proc.id, taken), shell: proc.shell })),
      declared.map((proc) => `${proc.id.padEnd(16)} Procfile  (${proc.shell})`),
      "Procfile"
    )
  }

  // 2. Workspaces.
  const globs = workspaceGlobs(root)
  const dirs = [
    ...new Set(globs.filter((g) => !g.startsWith("!")).flatMap((g) => expandGlob(root, g)))
  ]
  const fromWorkspaces: Array<InitProc> = []
  const workspaceNotes: Array<string> = []
  for (const dir of dirs) {
    const pkg = readPackage(root, dir)
    if (pkg === undefined) continue
    const script = devScript(pkg)
    if (script === undefined) continue
    const id = paneId(pkg.name, taken)
    fromWorkspaces.push({ id, shell: workspaceCommand(pm, pkg, script) })
    workspaceNotes.push(`${id.padEnd(16)} ${dir}  (${script})`)
  }
  if (fromWorkspaces.length > 0) return done(fromWorkspaces, workspaceNotes, "workspaces")

  // 3. Plain subdirectories, each its own project.
  const fromSubdirs: Array<InitProc> = []
  const subdirNotes: Array<string> = []
  for (const dir of subdirectories(root)) {
    const project = projectIn(root, dir, pm)
    if (project === undefined) continue
    const id = paneId(project.name, taken)
    fromSubdirs.push({ id, shell: project.shell, cwd: dir })
    subdirNotes.push(`${id.padEnd(16)} ${dir}/  (${project.what})`)
  }
  if (fromSubdirs.length > 0) return done(fromSubdirs, subdirNotes, "subdirectories")

  // 4. The root itself.
  const own = projectIn(root, ".", pm)
  if (own !== undefined) {
    const id = paneId(own.name, taken)
    return done([{ id, shell: own.shell }], [`${id.padEnd(16)} .  (${own.what})`], "root")
  }

  // 5. Nothing to go on — a template that runs, to be edited.
  return done(
    [{ id: "app", shell: "echo 'edit procdeck.config.json'; sleep 1000" }],
    [
      "nothing recognisable here (package.json scripts, Procfile, Django/Go/Rust/Rails/compose) — wrote a template to edit"
    ],
    "template"
  )
}
