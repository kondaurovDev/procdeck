/**
 * The package's public entry point — everything a `procdeck.config.ts` needs.
 *
 * The types are written out structurally instead of being derived from the
 * Effect schema in `config.ts`, because a derived type makes the emitted `.d.ts`
 * import `effect`, and effect is bundled into the CLI rather than installed:
 * consumers would be typechecking against a package they don't have.
 *
 * `tests/public.test.ts` asserts at the type level that this mirrors the schema
 * exactly, so the two cannot drift apart silently.
 */

/** A check that must pass before the proc spawns; failure parks it in `blocked`. */
export type Preflight = {
  /** Shell command; exit 0 lets the proc spawn. */
  readonly shell: string
  /** Regex the check's output must also match, for checks that exit 0 either way. */
  readonly expect?: string
  /** What the human should do when the check fails. */
  readonly hint?: string
}

/** A regex watched in the pane output; a match raises a badge in the UI. */
export type Alert = {
  readonly pattern: string
  /** Badge text. */
  readonly label: string
}

/** A single supervised process. Exactly one of `shell` / `cmd` is used. */
export type ProcSpec = {
  /** Pane label and proxy subdomain (`api` → http://api.localhost:4820). */
  readonly id: string
  /** Command line handed to `$SHELL -c`. */
  readonly shell?: string
  /** argv, executed without a shell. */
  readonly cmd?: ReadonlyArray<string>
  /** Working directory; defaults to the config file's directory. */
  readonly cwd?: string
  /** Extra environment; values may use `${port}` / `${port:other}`. */
  readonly env?: { readonly [key: string]: string }
  /** Spawn on startup. Defaults to true. */
  readonly autostart?: boolean
  /** URL this process serves, shown in the UI as a link. */
  readonly url?: string
  /** Ids of procs that must be ready before this one spawns. */
  readonly needs?: ReadonlyArray<string>
  /** What "ready" means for dependents. Defaults to "listening". */
  readonly readyWhen?: "listening" | "started"
  /**
   * Route this proc's assigned `${port}` through procdeck's HTTP observer
   * (`procdeck http` captures requests/responses). Defaults to true for
   * procs that use `${port}`; false hands the proc the public port directly.
   */
  readonly observe?: boolean
  readonly preflight?: Preflight
  readonly alerts?: ReadonlyArray<Alert>
}

/** A procdeck deck: the web UI's settings and the processes it supervises. */
export type ProcdeckConfig = {
  /** Only meaningful in a JSON config; accepted here for symmetry. */
  readonly $schema?: string
  /** Deck name; defaults to the config directory's basename. */
  readonly name?: string
  /** Port for the web UI and the `*.localhost` proxy. Defaults to 4820. */
  readonly port?: number
  /**
   * Interface the UI and proxy bind to. Defaults to "127.0.0.1" (loopback
   * only — the UI types into real terminals). "0.0.0.0" to reach the deck
   * from another machine or from a container's host.
   */
  readonly host?: string
  readonly procs: ReadonlyArray<ProcSpec>
}

/** Identity helper that gives config files their types. */
export const defineConfig = (config: ProcdeckConfig): ProcdeckConfig => config
