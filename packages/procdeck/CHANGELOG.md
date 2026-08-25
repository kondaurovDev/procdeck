# procdeck

## 1.0.0

### Major Changes

- 2364ad0: procdeck 1.0.0. Nothing breaks in this release — the version says the surface
  is settled and will not move under you without a major bump.

  What 1.0 promises to keep stable:

  - **The config**, both formats: every field of the schema (and therefore
    `schema.json`), the `${port}` / `${port:id}` templating, `needs` /
    `readyWhen` readiness, `preflight`, `alerts`, `observe`, and the
    `defineConfig` export.
  - **The CLI**: the verbs (`up`, `down`, `restart`, `status`, `ls`, `open`,
    `init`, `logs`, `mark`, `wait-for`, `errors`, `http`, `agents`, `mcp`),
    their flags, and the shape of every `--json` payload. `wait-for` keeps exit
    2 for a timeout.
  - **The MCP tools**: names and parameters of `deck_status`, `get_logs`,
    `get_http`, `get_errors`, `set_mark`, `wait_for`, `timeline`, and the
    `--mutations` trio.
  - **The addresses**: `<id>.localhost:<ui-port>` for every proc, the UI on
    4820 by default, loopback-only unless `host` says otherwise.

  Internals stay internal: the deck's HTTP API, the registry files under
  `~/.procdeck/`, the SSE event shapes and everything under `src/` are free to
  change.

  The readme is now the pitch and the docs live in `docs/` — config reference,
  the agent harness, the traffic observer and the architecture notes.

### Minor Changes

- 6ef989d: `procdeck restart --all` restarts every deck on this machine — stop, then detach again
  from each deck's own registry entry (foreground decks are skipped). The version a deck
  actually runs now shows in `status`, `ls` and the UI's deck switcher, and `status`/`up`
  say so out loud when it differs from the CLI — the answer to "did my update reach this
  deck?".

## 0.5.0

### Minor Changes

- 10b557f: procdeck is now a harness for coding agents, not just a dashboard for humans.
  New CLI verbs, all bounded and `--json`-able: `status --json` grows an
  `attention` list (crashed / blocked / alerting procs with reasons — the
  cheapest first question); `logs [proc]` returns pane output as plain
  timestamped lines (ANSI stripped, `\r` progress bars keep only their final
  state), filterable with `--grep`, `--since`, `--lines` — no proc means every
  proc interleaved with `[id]` prefixes, and the old daemon-log behaviour moved
  to `logs --self [-f]`; `mark [name]` drops a named marker in every proc's
  stream and `--since-mark` shows only what happened after it — the verify
  loop (mark → edit → restart → check) in four commands; `wait-for <proc>
[--pattern RE]` blocks until a listening port or a matching line, failing
  fast with the log tail if the proc crashes instead (exit 2 on timeout);
  `errors [proc]` parses stack traces out of recent output and deduplicates
  them by signature ("same TypeError, 41×, last 3s ago"); `restart <proc>`
  restarts a single process. `procdeck mcp` serves the same verbs over MCP
  (stdio) — `claude mcp add procdeck -- procdeck mcp` once, globally, and the
  instance registry finds the right deck per project; read-only by default,
  `--mutations` adds restart/stop/start, plus `since_last` cursors and a
  `timeline` tool. `procdeck agents` (and `procdeck init`) plant the discovery:
  a `## procdeck` section in CLAUDE.md / AGENTS.md and a Claude Code skill
  teaching the loop.
- 10b557f: procdeck sees the traffic now, not just the logs. Procs that use `${port}`
  get an HTTP observer interposed on their assigned port: the proc binds a
  hidden internal port, procdeck listens on the public one and forwards — so
  requests between processes (`${port:api}`) and into them are captured
  transparently, statuses and bodies included, with zero app changes
  (`"observe": false` opts a proc out; the `*.localhost` proxy captures for
  opted-out procs). WebSocket connections are captured per-message with
  direction and text — compression is stripped at the handshake so frames stay
  readable. Bodies are text-only and truncated (16 KB); `authorization`,
  `cookie` and friends are redacted before anything is stored. Three surfaces
  over the same per-proc rings: `procdeck http [proc] [--status 5xx|422|error]
[--path RE] [--since-mark] [--ws] [--body] [--digest] [--json]` — `--digest`
  groups 4xx/5xx by route with path params collapsed (`/users/:id`); a
  `get_http` MCP tool with `since_last` cursors (and `timeline` now carries
  the window's exchanges); and a traffic view in the UI — the ⇄ position of
  the layout switch — with kind/proc/errors filters, click-to-expand bodies,
  pause and clear. Marks span both streams, so mark → act →
  `http --since-mark` shows exactly which requests a change caused and what
  they returned.

## 0.4.0

### Minor Changes

- 8e4b627: procdeck runs in the background now. `procdeck up` (and bare `procdeck`) starts the
  deck detached, opens the UI and returns — no terminal tab kept hostage; `up --fg` is
  the old foreground mode. New commands, all working from anywhere inside the project:
  `down` (terminates every process tree), `restart`, `status`, `ls` (every running deck
  on the machine), `open` and `logs [-f]`. Running decks register in
  `~/.procdeck/instances/` (stale entries pruned by pid; `PROCDECK_HOME` relocates it);
  a detached deck's own output goes to `~/.procdeck/logs/`. `up` refuses a port already
  held by another deck — naming it — or simply busy, before anything spawns; a bad
  config is reported in the terminal, not in a log file. In the UI: ⏻ shuts the deck
  down (with a confirm), the page says so instead of "reconnecting" and revives itself
  when `procdeck up` runs again; the deck name in the bar lists the other running decks
  as links. The CLI moved to `effect/unstable/cli` — `--help` per command, shell
  completions via `--completions`.
- f2abc61: Three things for the first real release. **Loopback only:** the server binds
  `127.0.0.1` by default — the UI types into real terminals, so it is not something to
  put on the LAN by accident; `"host": "0.0.0.0"` in the config opens it up for
  devcontainers and VMs. **Per-proc backlog:** each proc keeps its last 256 KB of output
  and a new tab gets every pane's history plus a `synced` marker before live events — a
  chatty ticker can no longer evict a quiet server's startup lines, a deck that has run
  for days still opens with every pane populated, the UI knows exactly which chunks are
  news, and a reconnect replays into freshly reset panes instead of appending history to
  itself. **`procdeck init`:** writes a first `procdeck.config.json` from what is already there —
  a Procfile, workspace packages with `dev` scripts (via the package manager your lockfile
  points at), plain `backend/` + `frontend/` subdirectories (each its own package.json or
  a Django / Go / Rust / Rails / compose project, with `cwd` set), or the root itself.

### Patch Changes

- 9f944e5: The deck tells you when it needs you. Procs that crashed, are blocked on a preflight,
  carry an alert or have unread error lines count into the tab title (`(2) garage ·
procdeck`) and put a red dot on the favicon — visible from the tab strip and the Dock.
  A bell in the global bar turns on system notifications: a crash, a block or a new alert
  while the tab is hidden or the window unfocused shows one (click brings the deck back);
  replayed history on reconnect never notifies. The bell state persists with the UI state;
  the browser permission is asked for on the first click.
- 1db7f78: Grid pinning. Pin a proc (📌 in its pane header or sidebar row, ⌥P on the active one) and
  the grid shows only pinned procs; the rest collapse into a tray strip under the tiles —
  status dot, id, badges — where a click peeks at one and the pin puts it back. Nothing
  pinned = everyone tiled, as before. ⌥Z zooms the active tile in and out of single. The
  grid now sizes its columns from the tile count (near-square, at most 4) so the deck fits
  the screen when it can and scrolls only when tiles would drop under 180 px. Pins persist
  with the rest of the UI state.
- e90a08c: Polish before publishing, part one.

  - URLs in pane output are clickable (`Local: http://localhost:5173/` from every dev
    server opens in a new tab).
  - Exit status reads like a human wrote it: `exit 1 · 2m ago`, `killed (SIGTERM) · 5s ago`
    — signal names instead of numbers, and no more `signal 0` on a plain non-zero exit.
    Running procs that were respawned show a restart count (`↻3`), so crash loops are
    visible from the status line. The sidebar shows the same exit summary where uptime sits
    while running.
  - Grid tile headers keep the `*.localhost` address whole instead of clipping it to `:61`:
    compact tiles show only the primary address (raw ports in its tooltip) and the status
    text is what gives way first.
  - The assigned port no longer also counts as "internal" when it lands in the ephemeral
    range.

- a85d537: Light theme. A System · Light · Dark switch in the global bar; System follows the OS
  (`prefers-color-scheme`) and tracks it live. The terminals switch palette too — light gets
  its own ANSI set (GitHub Light), since xterm's defaults are unreadable on white. The choice
  is stored with the rest of the UI state and painted before the first frame, so there is
  no flash on reload.
- 512e814: The UI remembers itself across reloads, and says when it has lost the server.

  Layout (single/grid) and the selected pane are kept in localStorage — per origin, so per
  deck — and restored on the next load; a stored pane that is no longer in the config falls
  back to the first one. While the event stream is down (a `procdeck restart`, a killed
  server) a "reconnecting" banner sits over the panes instead of the UI silently showing
  stale state; when the stream is back the proc snapshot is refetched so statuses that
  changed in the meantime catch up. A stream the browser gave up on (server answered with
  something other than an event stream) is retried every 2 s.

## 0.3.0

### Minor Changes

- a1ced2e: Cut the install from 116 MB to 1.8 MB, and remove every reason for it to fail.

  `node-pty` is replaced by `@lydell/node-pty` — the same upstream sources and the same API,
  but the binaries ship as per-platform optional dependencies instead of one tarball carrying
  every platform's prebuilds. Upstream runs an install script and has no Linux prebuild at
  all, so Linux users needed a C++ toolchain and pnpm ≥ 10 / Bun users needed
  `pnpm approve-builds` (or `trustedDependencies`) on every platform or spawning failed at
  runtime. The replacement runs no install script and compiles nothing, anywhere — which also
  retires the startup hack that repaired the darwin `spawn-helper` execute bit.

  `effect` is no longer installed either: it is bundled into the CLI, where tree-shaking takes
  it from 48 MB on disk to under 1 MB of shipped code. The package's public entry point
  (`defineConfig` and the config types) is now a standalone module with no effect types in its
  declarations, so a `procdeck.config.ts` typechecks against a package that has none of
  procdeck's own dependencies installed.

## 0.2.0

### Minor Changes

- 212de8d: Accept `procdeck.config.json` next to the TypeScript config, validated by the same schema.
  A JSON deck needs nothing from the project's toolchain — no TypeScript, and procdeck itself
  does not have to be a dependency, so `npx procdeck` works in any repo. Point `$schema` at
  `https://unpkg.com/procdeck/schema.json` (generated from the Effect schema at build time and
  shipped with the package) for completion and validation in the editor.

  Started without an argument, the CLI now looks for `procdeck.config.json`, `.ts`, `.js` and
  `.mjs` in that order, and reports a missing or unreadable config against the file instead of
  crashing. `port` is validated as an integer in 1–65535.
