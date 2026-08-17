import { pathToFileURL } from "node:url"
import * as path from "node:path"
import { Effect, Schema } from "effect"

/**
 * A single supervised process.
 *
 * Exactly one of `shell` / `cmd` is used: `shell` goes through `sh -c` (pipes,
 * `&&`, globs work, at the cost of one extra process in the tree), `cmd` is an
 * argv array executed directly.
 */
/**
 * A gate that must pass before the process spawns — e.g. `wrangler whoami`
 * before a proc whose tree needs a Cloudflare token. Keeps interactive
 * auth flows out of supervised panes, where a restart would kill their
 * callback servers mid-handshake.
 */
const regexSource = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((pattern: string) => {
      try {
        new RegExp(pattern)
        return undefined
      } catch {
        return "expected a valid regular expression"
      }
    }),
  ),
)

export const PreflightSchema = Schema.Struct({
  /** Shell command; exit 0 lets the proc spawn. */
  shell: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /**
   * Regex that must also match the check's output. For checks that exit 0
   * either way — `wrangler whoami` reports "not authenticated" with exit 0 —
   * so the config doesn't need `| grep` pipelines.
   */
  expect: Schema.optionalKey(regexSource),
  /** What the human should do when the check fails. */
  hint: Schema.optionalKey(Schema.String),
})

export type Preflight = typeof PreflightSchema.Type

/** A regex watched in the pane output; a match raises a badge in the UI. */
export const AlertSchema = Schema.Struct({
  pattern: regexSource,
  /** Badge text. */
  label: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
})

export type Alert = typeof AlertSchema.Type

export const ProcSpecSchema = Schema.Struct({
  /** Stable identifier, also the tab label. */
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  /** Command line handed to `$SHELL -c`. */
  shell: Schema.optionalKey(Schema.String),
  /** argv, executed without a shell. */
  cmd: Schema.optionalKey(Schema.Array(Schema.String).pipe(Schema.check(Schema.isMinLength(1)))),
  /** Working directory; defaults to the config file's directory. */
  cwd: Schema.optionalKey(Schema.String),
  /** Extra environment on top of the inherited one. */
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Spawn on startup. Defaults to true. */
  autostart: Schema.optionalKey(Schema.Boolean),
  /** URL this process serves, shown in the UI as a link. */
  url: Schema.optionalKey(Schema.String),
  /**
   * Names of procs that must be ready before this one spawns. Declarative:
   * readiness is auto-detected, no port numbers in the config.
   */
  needs: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * What "ready" means for dependents: "listening" (default) — the process
   * tree opened a TCP port; "started" — it merely spawned (for procs that
   * never listen).
   */
  readyWhen: Schema.optionalKey(Schema.Literals(["listening", "started"])),
  /** Check that must pass before this proc spawns; failure shows as "blocked". */
  preflight: Schema.optionalKey(PreflightSchema),
  /** Output patterns that raise a badge when they appear in the pane. */
  alerts: Schema.optionalKey(Schema.Array(AlertSchema)),
}).pipe(
  Schema.check(
    Schema.makeFilter((spec: { shell?: string; cmd?: ReadonlyArray<string> }) =>
      (spec.shell === undefined) === (spec.cmd === undefined)
        ? "expected exactly one of `shell` or `cmd`"
        : undefined,
    ),
  ),
)

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
  /**
   * Deck name — the tab title and the name of the installed web app.
   * Defaults to the config directory's basename.
   */
  name: Schema.optionalKey(Schema.String),
  /** Port for the web UI. Defaults to 4820. */
  port: Schema.optionalKey(Schema.Number),
  procs: Schema.Array(ProcSpecSchema),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (config: { procs: ReadonlyArray<ProcSpec> }) =>
        validateGraph(config.procs) ?? validatePortTemplates(config.procs),
    ),
  ),
)

export type ProcdeckConfig = typeof ProcdeckConfigSchema.Type

/** Identity helper that gives config files their types. */
export const defineConfig = (config: ProcdeckConfig): ProcdeckConfig => config

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

export const loadConfig = Effect.fn("procdeck.loadConfig")(function* (file: string) {
  const absolute = path.resolve(file)
  const module = yield* Effect.tryPromise({
    try: () => import(pathToFileURL(absolute).href) as Promise<{ default?: unknown }>,
    catch: (cause) => new ConfigError({ file: absolute, message: String(cause) }),
  })
  const config = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(ProcdeckConfigSchema)(module.default),
    catch: (cause) => new ConfigError({ file: absolute, message: String(cause) }),
  })
  const root = path.dirname(absolute)
  const loaded: LoadedConfig = { config, root, name: config.name ?? path.basename(root) }
  return loaded
})
