# Plan

Backlog of agreed-on improvements, roughly ordered by value/effort. Recently
shipped items are at the bottom for context.

## Server: per-proc log buffers (shipped)

Shipped as designed below: `Runtime.backlog` (256 KB of chunks per proc,
`seq`-numbered), `Supervisor.events` is a `Stream` per subscriber that
subscribes to the live `PubSub.sliding({capacity: 4096})` first, then emits
every proc's backlog + status, `{type: "synced"}`, then live events with
`seq < snapshot` filtered out. The UI treats everything before `synced` as
history (`live: false`), dropped the 500 ms heuristic, and on reconnect
resets every mounted terminal before the replay lands (Commands are forked in
order and these are synchronous). Tests cover eviction isolation and the
seam.

**Problem (as it was).** All log chunks and status events shared one
`PubSub.sliding` (`EVENT_BUFFER = 5000` events). The guarantee it gave —
"last 5000 events *in total*" — was the wrong shape; what a fresh tab needs is
"the last N lines of *each* proc":

- A chatty proc (a per-second ticker, a verbose build watcher) evicts quiet
  procs' history; after a long run a new tab may open a near-empty pane.
- Status events live in the same ring, so in theory a chatty proc can evict a
  quiet proc's last `status` too (only the `GET /procs` snapshot saves it).
- Capacity can't be tuned per proc — raising it for one pays memory for all.
- The protocol has no end-of-backlog marker, so the UI can't tell replayed
  chunks from live ones (see the 500 ms heuristic below).

**Design.**

- Keep the PubSub, but as *live transport only*: drop (or shrink) `replay`.
- Each `Runtime` gets its own ring of chunks, bounded by **bytes** (e.g.
  256 KB per proc), not by event count — chunks vary wildly in size.
- On SSE connect the handler first sends, per proc: buffered backlog chunks +
  current status, then an explicit end-of-backlog marker (e.g.
  `{type: "synced"}`), then switches to the live subscription.
- Ordering subtlety: subscribe *first*, then read the buffers, so nothing
  published in between is lost. Duplicate chunks at the seam are harmless for
  a terminal (or can be cut by tagging chunks with a per-proc counter).

**Payoff beyond correctness:** the `synced` marker lets the UI drop the
"chunks within 500 ms of `open` are backlog" heuristic that currently keeps
replayed errors out of the unread badge (`ui/src/subscription.ts`).

## Next up (agreed order)

1. **Terminal niceties** (font size, Ctrl-C, copy-on-select) — see "Polish".
2. **Command palette** — once there are enough actions to put in it.
3. **Publishing checklist** below (hero GIF, comparison table, update hint).

Shipped from the previous list: registry + detached mode (`up` / `down` /
`restart` / `status` / `ls` / `open` / `logs`, Shutdown button) and the deck
switcher — see the two sections below.

## UI state survives a refresh (shipped: localStorage)

`layout` and `active` persist (`ui/src/storage.ts`); `pinned`, `theme` and
the sidebar width join the same record as they land. localStorage is the
right store: it is keyed per origin, and origin includes the port, so every
deck keeps its own state with no namespacing work. Do not persist `unread`,
`mounted`, `search`. Foldkit shape: **one** `SaveUiState` Command, appended
by a wrapper around `update` whenever any persisted field changed (no branch
can forget it); `init` reads the record back, `GotProcs` falls back to the
first proc if the stored `active` is gone from the config (pinned ids that
are gone get dropped the same way). Every field is optional on read so an old
record never blanks the UI. Alternatives rejected: URL hash (`#api`) —
back-button and sharing are not worth the routing for two fields;
server-side — outlives the browser but not the deck, and it is a disk write
for two fields.

**Reconnect banner (shipped).** `Model.stream` is connecting/open/reconnecting;
a drop shows a "reconnecting to procdeck…" strip overlaying the top of the
work area (same grid cell as sidebar+main, so nothing shifts), and the first
`open` after a drop refetches `/procs` — the ring replay is not guaranteed to
hold every status change made while the tab was deaf. EventSource retries on
its own while the server is unreachable; when it gives up (CLOSED) the
subscription retries every 2 s. Once per-proc buffers exist, the banner
should stay until `synced`, not just `open`.

## Theme: system / light / dark (shipped)

Three-state switch in the global bar — **System · Light · Dark** — defaulting
to System via `prefers-color-scheme` (GitHub/Linear/VS Code convention).

- `Model.theme` is the preference, `Model.systemDark` the OS state (a
  matchMedia subscription, always on so switching back to System is
  current); `resolveScheme` gives the painted scheme. CSS tokens: dark on
  `:root`, light under the media query (guarded `:not([data-theme="dark"])`)
  and under `[data-theme="light"]`; `color-scheme` follows so scrollbars and
  form controls match.
- The parts CSS can't reach — xterm palettes, the theme-color meta, the
  `data-theme` attribute — are one `ApplyTheme` Command, appended by the
  `update` wrapper whenever the preference or the resolved scheme changes.
  Light has a full ANSI set (GitHub Light); dark keeps xterm's defaults. A
  terminal is born in the current scheme (`currentScheme()` reads the DOM).
- No flash: an inline script in `index.html` reads the same localStorage
  record and sets `data-theme` + theme-color before the first frame.
- Not done: the generated manifest's `theme_color` is still dark — the
  runtime meta overrides it in Chromium, so it only matters for the install
  dialog.

## Grid pinning + tray (shipped)

Nine panes on one screen is the reality on a monorepo deck; the grid scrolls
and the crash below the fold is exactly the one that goes unseen. Patterns
that survive elsewhere (tmux status bar, Zellij tab bar, macOS minimise,
Grafana/Datadog "fit vs scroll"):

- **Pin + tray** (shipped). `Model.pinned` (persisted); `gridIds(model)` =
  pinned, or everyone when nothing is pinned. Pin toggles live on the pane
  header, the sidebar row (hover-revealed) and the tray chips; ⌥P toggles the
  active pane. Unpinned procs collapse into the **tray** under the grid —
  dot, id, badges — click the chip to *peek* (single on it), pin to put it
  back. The active pane may sit in the tray (after a peek + ⌥Z, say); it
  keeps its accent there because hotkeys still act on it. Stale pins are
  dropped on `GotProcs`, same as a stale `active`.
- **Fit** (shipped, without a toggle). Column count = ⌈√n⌉ capped at 4
  (`cols-N` class from `gridColumns` in view.ts, 2 columns under 1100 px, 1
  under 700 px); rows stretch and the grid scrolls only when they would drop
  under 180 px. With 9 tiles on 1400×800 nothing scrolls. Font scaling was
  not needed — pins are the pressure valve.
- **⌥Z zoom toggle** (shipped) — active tile ↔ single and back, the keyboard
  twin of double-clicking a tile header.
- **Status filter chips** in the global bar — running / exited / alerts
  (Docker Desktop, k9s). Cheap; answers "show me only what's broken". Not
  built yet.
- **Groups from config** (`group: "frontend"`) as collapsible grid sections
  and sidebar sections — later, when a deck outgrows pins.
- **Drag-to-reorder** — nice-to-have; not before pins have proven insufficient.
- **⌥1…⌥9** — jump to the N-th proc (mprocs/tmux habit).

## Polish before publishing

Small, all expected by anyone coming from a terminal, all cheap:

- **Clickable URLs in output** (shipped) — `@xterm/addon-web-links`.
- **Readable exit status** (shipped). `exit 1 · 2m ago` / `killed (SIGTERM)`;
  the server now sends signal *names* and treats node-pty's `signal: 0` as
  none (that was the `exited · signal 0`), plus `exitedAt` and a `restarts`
  counter (`↻3` in the status line). The sidebar shows the same summary in
  the uptime slot.
- **Pane header overflow** (shipped). Grid tiles show only the primary address
  (raw ports in its tooltip); the status text is what ellipsises first.
- **Title / favicon badge + notifications** (shipped). `attentionCount` =
  crashed (non-zero exit or signal — a clean `exit 0` is not an alarm) +
  blocked + alerting + unread-errors procs → `(N)` title prefix and
  `icon-alert.svg` as favicon (swapped by a Command from the `update`
  wrapper, like the theme). The bell (`Model.notifications`, persisted)
  requests permission on first click; `Notify` is issued by `update` on
  *transitions* only (fresh crash / block / alert) and only for live events —
  replayed status history on reconnect carries `live: false` now, same as log
  chunks. The Command itself stays quiet while the tab is visible and
  focused. `tag` per proc collapses repeats; click focuses the window.
- **Terminal niceties** (not built). ⌘+/⌘− font size, copy-on-select, wrap
  toggle, a "send Ctrl-C" action (stop signals the group; sometimes you want
  a plain ^C as in a terminal).
- **Command palette** (not built) ⌘P: jump to proc, restart/stop, pin, theme.
  Hotkeys are modifier-only and invisible; the palette makes them
  discoverable.

## Publishing checklist

- Hero GIF/screenshot right under the README title — a healthy deck, not a
  wall of red stacks.
- `procdeck init` (shipped) — scans `pnpm-workspace.yaml` / `workspaces`,
  one proc per package with a dev-ish script (`dev`, `start:dev`, `serve`,
  `watch`, `start`), run via the lockfile's package manager; a plain package
  gets its own script; nothing found → a template. Validates the file through
  the real loader before reporting. No `${port}` guessing — printed as a tip.
- A "vs mprocs / overmind / concurrently / turbo TUI" table — that is where
  users come from.
- (shipped) Binds `127.0.0.1` only now (`host` in the config to open up);
  README says so, plus no telemetry / no service worker.
- "Update available" hint in the global bar (daily npm version check) — with
  detached mode an upgrade needs an explicit `procdeck restart`.

## Detached mode as the default (shipped)

procdeck used to be a foreground process; the terminal tab it ran in was the
only lifecycle handle. That was the biggest day-to-day friction: a terminal
stayed open just to keep the deck alive — and it made the Dock icon half a
feature: an app icon for a deck that dies with its terminal.

- `procdeck up` (and bare `procdeck`) **detaches by default**: re-spawns
  itself as `up --fg --no-open` with `detached: true`, stdout/stderr in
  `~/.procdeck/logs/<id>.log`, `unref()`; the parent waits for the child's
  registry entry (written after `listen`) — so `up` returns only when the UI
  is reachable, and a busy port / bad config surface in the terminal (the
  parent probes the port and loads the config itself before spawning).
  Idempotent: `up` in a project that is already up prints "already up" and
  opens the browser. `--no-open` for scripts.
- `procdeck up --fg` — the old behaviour (Ctrl-C; second Ctrl-C forces).
- `procdeck down` / `restart` / `status` / `ls` / `open` / `logs [-f]` — via
  the registry, from anywhere inside the project (the config is located
  walking up from the cwd, like git/pnpm find their root).
- **⏻ in the UI** (`POST /__procdeck/api/shutdown`, confirm dialog) — there
  is no terminal to Ctrl-C any more. The server answers 200, then SIGTERMs
  itself, so the UI and the CLI share one shutdown path. The page then shows
  a "procdeck is shut down — `procdeck up` in <root> brings it back" banner,
  dims the stale panes, and revives itself when the feed is back (EventSource
  keeps retrying), refetching procs + deck info.
- The CLI is `effect/unstable/cli` (`Command`/`Flag`/`Argument`) with the Node
  service layers from `@effect/platform-node-shared` bundled in (no `undici`,
  tree-shaken; +0.3 MB on the bundle). `--help`, `--version`, shell
  completions come for free. `procdeck <config-path>` still works: the root
  command's positional is the config, so the README one-liner holds.
- Known cost: updating procdeck's own code needs `procdeck restart`, which
  restarts every pane. Noted in the README.
- Built-in global flags are trimmed via `CliConfig.layer({ builtIns })`: no
  `--wizard` (clutter); `--log-level` stays — with `--fg` the deck's own logs
  are right in the terminal (there are no debug-level lines yet; add some
  around port assignment / readiness when debugging needs them).
- Not done: a `--port` override flag.

## Instance registry (shipped)

One deck per project (a modular monolith = one deck), one port per deck
(`port` in the config). With several projects running detached, ports
shouldn't have to be memorized:

- A deck registers itself in `~/.procdeck/instances/<id>.json` once listening
  — name, root, config path, port, pid, log path, startedAt, version, mode;
  `id` = sha1 of the **real** root path (symlinks resolved — macOS `/var` vs
  `/private/var` would otherwise split one project in two). Deregister on
  shutdown (only if the entry is still ours); prune dead pids on read. This is
  also the pidfile for `procdeck down`. `PROCDECK_HOME` relocates the tree
  (tests, sandboxes).
- `procdeck ls` — every live deck: name, port, uptime, running/total (fetched
  from each deck's API), root. `status` — the current project's deck and its
  procs.
- `up` refuses a port already held by another deck (by registry, with the
  holder's name and root) and a port that is simply busy (probed) — before
  spawning anything. EADDRINUSE inside the server is explained the same way.
- **Deck switcher in the UI** (`GET /__procdeck/api/instances`, `self` flag):
  the deck name in the global bar is a button; the dropdown lists the other
  decks as plain `http://localhost:<port>` links (name, port, root + uptime in
  the tooltip). No CORS, no proxying; every deck serves its own UI. Fetched on
  open, so it is always current. Proc counts of other decks are not shown
  (would need CORS).
- `procdeck open` — resolve the current project's deck via the registry and
  open the browser on it.

**Decision: one installed app per project, switcher is navigation.** An
installed web app is bound to its origin, and origin includes the port — the
"garage" window *is* `localhost:4820`. Navigating it to `localhost:4830`
leaves the app's scope (Chrome keeps the window but shows an out-of-scope
address bar, and the window stays "garage"). So "one Dock icon with a deck
switcher inside" cannot exist without a hub that proxies every deck under one
origin — which is exactly the daemon/cockpit split rejected below. Hence:
the Dock-icon-per-project model stays (it also matches one-deck-per-monolith
and PWA scoping perfectly), the deck name stays in the title (Dock and ⌘Tab
need it), and the switcher is a link list — from a tab it is navigation, from
an installed window it opens in the browser or in that deck's own app.

**Decision: keep the UI embedded, don't split daemon/cockpit.** A separate
cockpit backend talking to headless daemons buys one thing — a single
memorable address — at the cost of CORS/SSE proxying, cockpit↔daemon version
skew and a second lifecycle to manage; the `*.localhost` proxy pins a port
per deck anyway. The same "one address" need is served by the registry:
every deck's UI lists all decks, and if a stable address is still wanted
later, a tiny fixed-port hub page that reads the registry and redirects is
enough — a page, not a backend. Out of scope: a hub view mixing panes of
several decks on one page (needs SSE proxying).

## Layout modes (decision)

The main area has one `layout` switch — a segmented control in the header
plus ⌥G cycling — not independent toggles. Modes:

- **single** — one pane fills the area (the original UI).
- **grid** — every pane at once as compact tiles (columns auto-fill at
  ≥420px, rows ≥240px, the grid scrolls when they don't fit — terminals
  auto-scroll to the tail, so a short tile still shows what matters). The
  sidebar is hidden: every tile carries its own header (dot, id, badges,
  address, status). The active pane has the accent frame, click a tile to
  make it active, double-click its header to zoom back to single on it.
  Cheap because there is already one xterm per proc; grid is only a layout
  change plus fitting every visible terminal instead of just the active one.
- **merged** (reserved, not built) — one chronological stream of all procs'
  lines with `[id]` prefixes. Different rendering (a line list, not xterm),
  needs a per-proc server-side line buffer. Lower value in procdeck than in
  foreman/concurrently — badges + panes already answer "did something break";
  merged only answers "in what order across procs". Build when that itch is
  real, not before.

Chrome (decision): a **global bar** across the top holds only deck-wide
things — brand, layout switch, ⌘F search box, "↻ all" / "■ all". Every pane
has its own **pane header** (dot, id, badges, addresses, status, and
↻ ■/▶ ⌫ icon buttons that fade in on hover) in both layouts, so "what I see
is what I act on" holds in grid. The sidebar in single is the proc list plus
hotkey hints; in grid it is hidden. If the per-pane icons ever feel noisy,
collapsing them into a "⋯" menu is a view-only change.

Rules that hold in every mode, so merged slots in later without churn:

- There is always exactly one **active** proc; ⌥R/⌥S and ⌘K/⌘F act on it.
  Grid marks it with a frame; merged will make `[id]` prefixes clickable to
  select it.
- ⌘F/⌘K stay routed through `update.ts` as Commands — single/grid implement
  them via the xterm addons, merged will implement them over the line buffer.
- Unread-error badges count lines landing in a non-active pane, whatever the
  layout; in grid they sit on the tile headers.
- Nothing new may assume "output only exists inside xterm" — the merged view
  and the grep filter both need lines outside it.

## UI wishlist (not yet built)

- **Merged view** — see "Layout modes" above; the third position of the layout
  switch. Needs log lines outside xterm scrollback, so it pairs naturally with
  per-proc server buffers.
- **Grid pinning** — promoted to a decision, see "Grid pinning + tray" above.
- **Line filter (grep mode)** — show only lines matching a pattern. xterm
  can't hide lines, so this is a separate filtered view rendered from a log
  buffer, not an xterm feature. Also pairs with per-proc buffers.
- **Restart count + last exit code** in the sidebar — the red dot says
  "crashed", but not "crashed 12 times, last exit 1".
- **Copy / download logs** — "copy visible" and "download full log".
- **CPU / memory per proc** in the sidebar (the port poller already walks the
  process group once a second; `ps` can ride along).
- **Timestamps toggle** — prefix each line with wall-clock time.

## Shipped (for context)

- Installable web app (PWA-lite): per-deck manifest generated by the server
  (`name` from config, else the config dir's basename — every deck is its
  own origin/port, so its own Dock icon), icons in `ui/public`, an
  "⤓ install" button in the global bar driven by `beforeinstallprompt`
  (Chromium; Safari users go File → Add to Dock). No service worker on
  purpose — a cached dev-tool UI goes stale. Real payoff arrives with daemon
  mode: a Dock icon for a deck that dies with its terminal is half a feature.
- Layout modes single/grid (see above), ⌥G cycles; global bar + per-pane
  headers with controls; "↻ all" / "■ all" (client-side loop over the
  existing per-proc endpoints — restart is stop+start, so it also brings up
  stopped procs; stop-all skips idle ones).
- Hotkeys: ⌘K clear, ⌘F search (xterm search addon, Enter/⇧Enter step,
  Esc closes), ⌥↑/⌥↓ switch proc, ⌥R restart, ⌥S stop/start toggle.
  Modifier-only on purpose — bare keys and bare Ctrl belong to the PTY.
- Sticky scroll: "↓ output below" overlay when new output lands off-screen.
- Unread-error badge: error-looking lines arriving in a non-active pane bump
  a red counter on the sidebar row; selecting the proc clears it. Backlog
  replay is excluded via the 500 ms window heuristic (see above).
