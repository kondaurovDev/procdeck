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

1. **UI state in localStorage** — half an hour, immediately felt.
2. **Registry + detached mode** (`up` / `down` / `status` / `open`, Shutdown
   button) — the core.
3. **Deck switcher dropdown** in the global bar — cheap on top of the registry.

## UI state survives a refresh (decision: localStorage)

Persist `layout` and `active` so a reload (or reopening the installed app)
lands where the user left off. localStorage is the right store: it is keyed
per origin, and origin includes the port, so every deck keeps its own state
with no namespacing work. Do not persist `unread`, `mounted`, `search`.
Foldkit shape: a `SaveUiState` Command emitted from `update` whenever layout
or active changes; `init` reads it back, falling back to the first proc if
the stored `active` no longer exists in the config. Alternatives rejected:
URL hash (`#api`) — back-button and sharing are not worth the routing for
two fields; server-side — outlives the browser but not the deck, and it is a
disk write for two fields.

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
- **Grid pinning** — if 6+ tiles prove unreadable: a per-proc pin in the
  sidebar, grid shows only pinned procs (all when nothing is pinned).
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
