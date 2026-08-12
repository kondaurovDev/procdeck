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

## Daemon mode (run without a dedicated terminal)

Today procdeck is a foreground process; the terminal tab it runs in is the
only lifecycle handle (Ctrl-C / SIGTERM tears everything down via the
supervisor scope). That's the biggest day-to-day friction: a terminal stays
open just to keep the deck alive.

- `procdeck up -d` — daemonize: detach, write a pidfile, log to a file.
- `procdeck down` / `procdeck status` — stop / inspect without the terminal.
- **Shutdown button in the UI** (`POST /__procdeck/shutdown`) — quit the whole
  deck from the browser; with `-d` the terminal is never needed at all.
- Interim workarounds: `nohup procdeck … &` + `kill`, or a VS Code task with
  `"runOn": "folderOpen"`.

## Instance registry (find all running decks from any UI)

One deck per project, one port per deck (`port` in the config). With several
projects running detached, ports shouldn't have to be memorized:

- On start, a deck registers itself in `~/.procdeck/instances/` — project
  name, root path, port, pid. Deregister on shutdown; prune stale entries
  (dead pid) on read. The pidfile for `procdeck down` lives here too.
- `procdeck ls` — list live decks: project, port, running/total procs.
- **Deck switcher in the UI** — the server exposes the registry
  (`GET /__procdeck/instances`); the sidebar grows an "other decks" section
  linking to each deck's port. Switching is plain navigation to that port —
  no CORS, no proxying; every deck serves its own UI.
- Out of scope for now: a hub view mixing panes of several decks on one page
  (needs SSE proxying; one-click switching should cover the need).
- `procdeck open` — resolve the current project's deck via the registry and
  open the browser on it; nobody has to remember ports.

**Decision: keep the UI embedded, don't split daemon/cockpit.** A separate
cockpit backend talking to headless daemons buys one thing — a single
memorable address — at the cost of CORS/SSE proxying, cockpit↔daemon version
skew and a second lifecycle to manage; the `*.localhost` proxy pins a port
per deck anyway. The same "one address" need is served by the registry:
every deck's UI lists all decks, and if a stable address is still wanted
later, a tiny fixed-port hub page that reads the registry and redirects is
enough — a page, not a backend.

## UI wishlist (not yet built)

- **Merged view** — all procs in one stream with colour-coded `[api]` /
  `[web]` prefixes (foreman/concurrently style). Useful when debugging
  cross-proc interactions. Needs log lines outside xterm scrollback, so it
  pairs naturally with per-proc server buffers.
- **Line filter (grep mode)** — show only lines matching a pattern. xterm
  can't hide lines, so this is a separate filtered view rendered from a log
  buffer, not an xterm feature. Also pairs with per-proc buffers.
- **Restart count + last exit code** in the sidebar — the red dot says
  "crashed", but not "crashed 12 times, last exit 1".
- **Restart all / Stop all** — one button for the whole set.
- **Copy / download logs** — "copy visible" and "download full log".
- **CPU / memory per proc** in the sidebar (the port poller already walks the
  process group once a second; `ps` can ride along).
- **Timestamps toggle** — prefix each line with wall-clock time.

## Shipped (for context)

- Hotkeys: ⌘K clear, ⌘F search (xterm search addon, Enter/⇧Enter step,
  Esc closes), ⌥↑/⌥↓ switch proc, ⌥R restart, ⌥S stop/start toggle.
  Modifier-only on purpose — bare keys and bare Ctrl belong to the PTY.
- Sticky scroll: "↓ output below" overlay when new output lands off-screen.
- Unread-error badge: error-looking lines arriving in a non-active pane bump
  a red counter on the sidebar row; selecting the proc clears it. Backlog
  replay is excluded via the 500 ms window heuristic (see above).
