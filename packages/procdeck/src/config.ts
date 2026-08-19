import { existsSync, realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import * as path from "node:path"
import { Effect, Schema } from "effect"

/**
 * The config schema, and the loader for the two file formats it accepts.
 *
 * Every user-facing sentence lives in a `description` annotation rather than a
 * JSDoc comment: `scripts/gen-schema.ts` turns this schema into the published
 * `schema.json`, so a JSON config gets the same prose as editor tooltips, from
 * a single source that cannot drift.
 */

const isRegex = Schema.makeFilter((pattern: string) => {
  try {
    new RegExp(pattern)
    return undefined
  } catch {
    return "expected a valid regular expression"
  }
})

/**
 * Annotations go on the schema *before* its checks: a description attached
 * afterwards lands inside the JSON Schema's `allOf`, where editors don't look
 * for it. Same reason the length-checked fields below are built in that order.
 */
const regexSource = (annotations: { description: string; examples: Array<string> }) =>
  Schema.String.annotate(annotations).pipe(Schema.check(isRegex))

export const PreflightSchema = Schema.Struct({
  shell: Schema.String.annotate({
    description: "Shell command; exit 0 lets the proc spawn.",
    examples: ["wrangler whoami"],
  }).pipe(Schema.check(Schema.isMinLength(1))),
  expect: Schema.optionalKey(
    regexSource({
      description:
        "Regex the check's output must also match. For checks that exit 0 either way — `wrangler whoami` reports \"not authenticated\" with exit 0 — so the config needs no `| grep` pipelines.",
      examples: ["You are logged in"],
    }),
  ),
  hint: Schema.optionalKey(
    Schema.String.annotate({
      description: "What the human should do when the check fails; shown on the blocked pane.",
      examples: ["run `wrangler login`, then Start"],
    }),
  ),
}).annotate({
  description:
    "A gate that must pass before the process spawns — e.g. `wrangler whoami` before a proc whose tree needs a Cloudflare token. Keeps interactive auth flows out of supervised panes, where a restart would kill their callback servers mid-handshake.",
})

export type Preflight = typeof PreflightSchema.Type

export const AlertSchema = Schema.Struct({
  pattern: regexSource({
    description: "Regex matched against a rolling tail of the pane's output.",
    examples: ["ERROR", "not authenticated"],
  }),
  label: Schema.String.annotate({
    description: "Badge text shown in the UI when the pattern matches.",
    examples: ["needs login"],
  }).pipe(Schema.check(Schema.isMinLength(1))),
}).annotate({
  description: "A regex watched in the pane output; a match raises a badge in the UI.",
})

export type Alert = typeof AlertSchema.Type

export const ProcSpecSchema = Schema.Struct({
  id: Schema.String.annotate({
    description:
      "Stable identifier: the pane label, and the proxy subdomain (`api` → http://api.localhost:4820).",
    examples: ["api", "web"],
  }).pipe(Schema.check(Schema.isMinLength(1))),
  shell: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Command line handed to `$SHELL -c` — pipes, `&&` and globs work. Exactly one of `shell` or `cmd` must be set.",
      examples: ["pnpm --filter api dev"],
    }),
  ),
  cmd: Schema.optionalKey(
    Schema.Array(Schema.String)
      .annotate({
        description:
          "argv, executed directly without a shell. Exactly one of `shell` or `cmd` must be set.",
        examples: [["node", "server.js"]],
      })
      .pipe(Schema.check(Schema.isMinLength(1))),
  ),
  cwd: Schema.optionalKey(
    Schema.String.annotate({
      description: "Working directory; defaults to the config file's directory.",
      examples: ["packages/api"],
    }),
  ),
  env: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String).annotate({
      description:
        "Extra environment on top of the inherited one. Values may use `${port}` / `${port:other}` templates.",
      examples: [{ PORT: "${port}", API_URL: "http://localhost:${port:api}" }],
    }),
  ),
  autostart: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Spawn on startup. Defaults to true; false leaves the pane idle until Start.",
    }),
  ),
  url: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "URL this process serves, shown in the UI as a link. Also pins readiness to that URL's port.",
      examples: ["http://localhost:${port}"],
    }),
  ),
  needs: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "Ids of procs that must be ready before this one spawns. Declarative: readiness is auto-detected, no port numbers in the config.",
      examples: [["api"]],
    }),
  ),
  readyWhen: Schema.optionalKey(
    Schema.Literals(["listening", "started"]).annotate({
      description:
        'What "ready" means for dependents: "listening" (default) — the process tree opened a TCP port; "started" — it merely spawned, for procs that never listen.',
    }),
  ),
  preflight: Schema.optionalKey(PreflightSchema),
  alerts: Schema.optionalKey(
    Schema.Array(AlertSchema).annotate({
      description: "Output patterns that raise a badge when they appear in the pane.",
    }),
  ),
}).pipe(
  Schema.check(
    Schema.makeFilter((spec: { shell?: string; cmd?: ReadonlyArray<string> }) =>
      (spec.shell === undefined) === (spec.cmd === undefined)
        ? "expected exactly one of `shell` or `cmd`"
        : undefined,
    ),
  ),
).annotate({
  description:
    "A single supervised process. Exactly one of `shell` / `cmd` is used: `shell` goes through `sh -c` (pipes, `&&`, globs work, at the cost of one extra process in the tree), `cmd` is an argv array executed directly.",
})

export type ProcSpec = typeof ProcSpecSchema.Type

/** Default port of the UI + proxy server. */
export const DEFAULT_UI_PORT = 4820

/**
 * Port templating: `${port}` is a free port procdeck assigns to this proc
 * before spawning; `${port:api}` is the port assigned to another proc — for
 * wiring dependents (`API_URL=http://localhost:${port:api}`). Allowed in
 * `shell`, `cmd`, `env` values and `url`. A proc that uses `${port}` also gets
 * `PORT` in its environment.
 */
const PORT_TEMPLATE = /\$\{port(?::([^}]+))?\}/g

const templatedStrings = (spec: ProcSpec): Array<string> =>
  [spec.shell, ...(spec.cmd ?? []), ...Object.values(spec.env ?? {}), spec.url].filter(
    (text): text is string => text !== undefined,
  )

/** Whether the spec asks procdeck to assign it a port (`${port}` anywhere). */
export const usesOwnPort = (spec: ProcSpec): boolean =>
  templatedStrings(spec).some((text) =>
    [...text.matchAll(PORT_TEMPLATE)].some((match) => match[1] === undefined),
  )

const portRefs = (spec: ProcSpec): Array<string> =>
  templatedStrings(spec).flatMap((text) =>
    [...text.matchAll(PORT_TEMPLATE)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])),
  )

/** Substitute `${port}` / `${port:id}` with the ports assigned at startup. */
export const resolveSpec = (spec: ProcSpec, assigned: Map<string, number>): ProcSpec => {
  const sub = (text: string): string =>
    text.replace(PORT_TEMPLATE, (whole, ref: string | undefined) => {
      const port = assigned.get(ref ?? spec.id)
      return port === undefined ? whole : String(port)
    })
  return {
    ...spec,
    ...(spec.shell === undefined ? {} : { shell: sub(spec.shell) }),
    ...(spec.cmd === undefined ? {} : { cmd: spec.cmd.map(sub) }),
    ...(spec.env === undefined
      ? {}
      : { env: Object.fromEntries(Object.entries(spec.env).map(([key, value]) => [key, sub(value)])) }),
    ...(spec.url === undefined ? {} : { url: sub(spec.url) }),
  }
}

/** Duplicate ids, unknown `needs` targets and dependency cycles, as one message. */
const validateGraph = (
  procs: ReadonlyArray<{ id: string; needs?: ReadonlyArray<string> }>,
): string | undefined => {
  const ids = new Set(procs.map((proc) => proc.id))
  if (ids.size !== procs.length) return "duplicate proc ids"

  for (const proc of procs) {
    for (const need of proc.needs ?? []) {
      if (!ids.has(need)) return `proc "${proc.id}" needs unknown proc "${need}"`
    }
  }

  // Depth-first search over `needs`; a node on the current path twice = cycle.
  const needsOf = new Map(procs.map((proc) => [proc.id, proc.needs ?? []]))
  const done = new Set<string>()
  const onPath = new Set<string>()
  const visit = (id: string): string | undefined => {
    if (done.has(id)) return undefined
    if (onPath.has(id)) return `dependency cycle through "${id}"`
    onPath.add(id)
    for (const need of needsOf.get(id) ?? []) {
      const cycle = visit(need)
      if (cycle !== undefined) return cycle
    }
    onPath.delete(id)
    done.add(id)
    return undefined
  }
  for (const proc of procs) {
    const cycle = visit(proc.id)
    if (cycle !== undefined) return cycle
  }
  return undefined
}

/** `${port:x}` must point at an existing proc that itself uses `${port}`. */
const validatePortTemplates = (procs: ReadonlyArray<ProcSpec>): string | undefined => {
  const byId = new Map(procs.map((proc) => [proc.id, proc]))
  for (const proc of procs) {
    for (const ref of portRefs(proc)) {
      const target = byId.get(ref)
      if (target === undefined) {
        return `proc "${proc.id}" references \${port:${ref}} but there is no proc "${ref}"`
      }
      if (!usesOwnPort(target)) {
        return `proc "${proc.id}" references \${port:${ref}} but "${ref}" does not use \${port} itself`
      }
    }
  }
  return undefined
}

export const ProcdeckConfigSchema = Schema.Struct({
  // JSON configs point at the published schema for editor completion; the key
  // is meaningless at runtime but must be accepted, because Struct is exact.
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: "URL of the procdeck JSON schema, for editor completion and validation.",
      examples: ["https://unpkg.com/procdeck/schema.json"],
    }),
  ),
  name: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Deck name — the tab title and the name of the installed web app. Defaults to the config directory's basename.",
      examples: ["my-app"],
    }),
  ),
  port: Schema.optionalKey(
    Schema.Number.annotate({
      description: "Port for the web UI and the `*.localhost` proxy. Defaults to 4820.",
      examples: [4820],
    }).pipe(Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  ),
  procs: Schema.Array(ProcSpecSchema).annotate({
    description: "The processes this deck supervises.",
  }),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (config: { procs: ReadonlyArray<ProcSpec> }) =>
        validateGraph(config.procs) ?? validatePortTemplates(config.procs),
    ),
  ),
).annotate({
  description: "A procdeck deck: the web UI's settings and the processes it supervises.",
})

export type ProcdeckConfig = typeof ProcdeckConfigSchema.Type

// `defineConfig` lives in `public.ts`: it is the one thing consumers import, and
// that entry must not drag effect's types into the published declarations.

export type LoadedConfig = {
  config: ProcdeckConfig
  /** Directory of the config file — the default cwd for every process. */
  root: string
  /** `config.name`, or the root directory's basename. */
  name: string
}

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  file: Schema.String,
  message: Schema.String,
}) {}

/**
 * Config file names the CLI looks for when started without an argument, in
 * order. JSON comes first because it needs nothing from the toolchain: no
 * TypeScript, and no procdeck in the project's dependencies.
 */
export const CONFIG_FILENAMES = [
  "procdeck.config.json",
  "procdeck.config.ts",
  "procdeck.config.js",
  "procdeck.config.mjs",
] as const

/** The first config file present in `dir`, if any. */
export const discoverConfig = (dir: string): string | undefined =>
  CONFIG_FILENAMES.map((name) => path.join(dir, name)).find((candidate) => existsSync(candidate))

/**
 * The nearest config walking up from `dir` — so `procdeck up|down|open` work
 * from anywhere inside the project, the way `git` and `pnpm` find their root.
 */
export const locateConfig = (dir: string): string | undefined => {
  let current = path.resolve(dir)
  while (true) {
    const found = discoverConfig(current)
    if (found !== undefined) return found
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * JSON is parsed; everything else is imported as a module and must default-export
 * the deck. Node strips the types of a `.ts` config itself — that, and nothing
 * else, is why procdeck asks for Node ≥ 22.18.
 */
const readSource = async (absolute: string): Promise<unknown> => {
  if (path.extname(absolute) === ".json") {
    return JSON.parse(await readFile(absolute, "utf8")) as unknown
  }
  const module = (await import(pathToFileURL(absolute).href)) as { default?: unknown }
  return module.default
}

export const loadConfig = Effect.fn("procdeck.loadConfig")(function* (file: string) {
  if (!existsSync(file)) {
    return yield* new ConfigError({ file: path.resolve(file), message: "config file not found" })
  }
  // Real path, so `root` (the project's identity in the registry) does not
  // depend on whether the config was reached through a symlink.
  const absolute = realpathSync(path.resolve(file))
  const source = yield* Effect.tryPromise({
    try: () => readSource(absolute),
    catch: (cause) => new ConfigError({ file: absolute, message: String(cause) }),
  })
  const config = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(ProcdeckConfigSchema)(source),
    catch: (cause) => new ConfigError({ file: absolute, message: String(cause) }),
  })
  const root = path.dirname(absolute)
  const loaded: LoadedConfig = { config, root, name: config.name ?? path.basename(root) }
  return loaded
})
