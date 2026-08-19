# Plan

Backlog of agreed-on improvements, roughly ordered by value/effort. Recently
shipped items are at the bottom for context.

## Server: per-proc log buffers (replaces the shared event ring)

**Problem.** All log chunks and status events share one `PubSub.sliding`
(`EVENT_BUFFER = 5000` events, `supervisor.ts`). The guarantee it gives —
"last 5000 events *in total*" — is the wrong shape; what a fresh tab needs is
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

1. **Theme: system / light / dark** — see "Theme" below.
2. **Pin + tray + ⌥Z** in grid, "fit" toggle — see "Grid pinning" below; the
   least obvious design, so prototype it on a 9-pane deck early.
3. **Pre-publish polish** — clickable URLs, title/favicon badge + notifications,
   readable exit status — see "Polish before publishing".
4. **Registry + detached mode** (`up` / `down` / `status` / `open`, Shutdown
   button) — the core.
5. **Deck switcher dropdown** in the global bar — cheap on top of the registry.
6. **Command palette** — once there are enough actions to put in it.

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

## Theme: system / light / dark (decision)

Three-state switch in the global bar — **System · Light · Dark** — defaulting
to System via `prefers-color-scheme` (GitHub/Linear/VS Code convention). Today
`ui/src/styles.css` hardcodes a dark palette on `:root` with
`color-scheme: dark`, and `terminal.ts` passes a fixed xterm theme.

- Two token sets on `:root` / `[data-theme="dark"]`, with the
  `prefers-color-scheme` media query covering the System state; `color-scheme`
  follows so scrollbars and form controls match.
- xterm is recoloured separately (`terminal.options.theme = …` on every
  mounted terminal when the theme changes) — and the **light theme needs its
  own ANSI palette**: the default bright yellow/cyan are unreadable on white.
  Use a proven light scheme (One Light / GitHub Light) rather than inverting.
- The web-app manifest's `theme_color` should follow, or the installed window
  gets a dark title bar on a light page.
- The choice is persisted with the rest of the UI state.

## Grid pinning + tray (decision)

Nine panes on one screen is the reality on a monorepo deck; the grid scrolls
and the crash below the fold is exactly the one that goes unseen. Patterns
that survive elsewhere (tmux status bar, Zellij tab bar, macOS minimise,
Grafana/Datadog "fit vs scroll"), in the order to build them:

- **Pin + tray.** A per-proc pin (pane header icon, ⌥P, sidebar row). Pinned
  procs render as grid tiles; unpinned ones collapse into a **tray** — a
  narrow strip below the grid with dot, id and the unread/alert badge per
  proc, so a crash in an unpinned pane is still one glance away. Click a tray
  item to *peek* (temporarily zoom to it in single), pin to keep it in the
  grid. With nothing pinned the grid shows everything, as today. Pinned tiles
  come first, so pinning is also the 80 % answer to "let me reorder tiles".
- **Fit toggle.** Grid mode flag: instead of scrolling, tiles shrink (columns
  auto, xterm font scaled down to a floor) so the whole deck stays on screen;
  when it can't fit even at the floor, the tray is the pressure valve.
  Default to fit; scroll stays available.
- **⌥Z zoom toggle** — active tile ↔ single and back (tmux `prefix z`), the
  keyboard twin of double-clicking a tile header.
- **Status filter chips** in the global bar — running / exited / alerts
  (Docker Desktop, k9s). Cheap; answers "show me only what's broken".
- **Groups from config** (`group: "frontend"`) as collapsible grid sections
  and sidebar sections — later, when a deck outgrows pins.
- **Drag-to-reorder** — nice-to-have; not before pins have proven insufficient.
- **⌥1…⌥9** — jump to the N-th proc (mprocs/tmux habit).

## Polish before publishing

Small, all expected by anyone coming from a terminal, all cheap:

- **Clickable URLs in output** (`@xterm/addon-web-links`). Vite prints
  `Local: http://localhost:61645/` and everybody expects to click it.
- **Readable exit status.** `exited · signal 0` is confusing; render
  `exit 1 · 2 m ago` / `killed (SIGTERM)`, plus restart count (already in the
  wishlist).
- **Pane header overflow.** Tiles truncate addresses to `:6164` / `:61`. Keep
  the `*.localhost` address whole; put raw ports in a tooltip or a "⋯" menu.
- **Title / favicon badge + notifications.** `(2) garage` in `<title>`, a red
  dot on the favicon, and Web Notifications on crash/alert while the tab is
  hidden (Gmail/Slack pattern). For a dashboard living on the second monitor
  this is the most useful single feature.
- **Terminal niceties.** ⌘+/⌘− font size, copy-on-select, wrap toggle, a
  "send Ctrl-C" action (stop signals the group; sometimes you want a plain ^C
  as in a terminal).
- **Command palette** ⌘P: jump to proc, restart/stop, pin, theme. Hotkeys are
  modifier-only and invisible; the palette makes them discoverable.

## Publishing checklist

- Hero GIF/screenshot right under the README title — a healthy deck, not a
  wall of red stacks.
- `procdeck init` — scan `package.json` / `pnpm-workspace.yaml` and generate a
  config with one proc per workspace `dev` script. Turns "write a JSON" into
  "run one command".
- A "vs mprocs / overmind / concurrently / turbo TUI" table — that is where
  users come from.
- State plainly: binds `127.0.0.1` only, no telemetry, no service worker.
- "Update available" hint in the global bar (daily npm version check) — with
  detached mode an upgrade needs an explicit `procdeck restart`.

## Detached mode as the default (decision)

Today procdeck is a foreground process; the terminal tab it runs in is the
only lifecycle handle (Ctrl-C / SIGTERM tears everything down via the
supervisor scope). That's the biggest day-to-day friction: a terminal stays
open just to keep the deck alive — and it makes the Dock icon (see "Shipped")
half a feature: an app icon for a deck that dies with its terminal.

- `procdeck up` — **detaches by default**: re-spawns itself with
  `--foreground`, `detached: true`, stdout/stderr to a log file, `unref()`,
  and writes its registry entry (below). Idempotent: `up` in a project that is
  already up prints "already up on :4820" and opens the browser.
- `procdeck up --fg` — the current behaviour, for debugging and terminal
  people.
- `procdeck down` / `restart` / `status` / `logs` / `open` — via the registry,
  from anywhere inside the project.
- **Shutdown button in the UI** (`POST /__procdeck/shutdown`) becomes
  mandatory — there is no terminal to Ctrl-C any more.
- Known cost: updating procdeck's own code needs `procdeck restart`, which
  restarts every pane (felt today when the manifest route needed a server
  restart). Acceptable; note it in the docs.
- Interim workarounds until then: `nohup procdeck … &` + `kill`, or a VS Code
  task with `"runOn": "folderOpen"`.

## Instance registry (find all running decks from any UI)

One deck per project (a modular monolith = one deck), one port per deck
(`port` in the config). With several projects running detached, ports
shouldn't have to be memorized:

- On start, a deck registers itself in `~/.procdeck/instances/<id>.json` —
  name, root path, port, pid, log path. Deregister on shutdown; prune stale
  entries (dead pid) on read. This is also the pidfile for `procdeck down`.
- `procdeck ls` — list live decks: project, port, running/total procs.
- **Deck switcher in the UI** — the server exposes the registry
  (`GET /__procdeck/instances`); clicking the deck name in the global bar
  opens a dropdown "other decks: sheldon :4830 · 5/6 running, my-exp :4840 ·
  stopped" → plain navigation to that port. No CORS, no proxying; every deck
  serves its own UI. Rare action, so the caveat below is acceptable.
- `procdeck open` — resolve the current project's deck via the registry and
  open the browser on it; nobody has to remember ports.
- One infrastructure, two consumers: `down/status` and the switcher both read
  the same registry.

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
