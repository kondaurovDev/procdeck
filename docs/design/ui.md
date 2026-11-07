# Web UI decisions

The parts of the UI that were decided rather than merely built: how the
panes are laid out, how a monorepo deck stays readable, what survives a
reload. The app is [Foldkit](https://foldkit.dev) (Elm on Effect) in `ui/`,
embedded into the binary.

## Layout modes

The main area has **one `layout` switch** — a segmented control in the global
bar plus ⌥G cycling — not independent toggles:

- **single** — one pane fills the area; the sidebar lists the procs.
- **grid** — every pane at once as tiles; the sidebar is hidden because every
  tile carries its own header. Columns = ⌈√n⌉ capped at 4, 2 under 1100 px,
  1 under 700 px; rows stretch and the grid scrolls only when they would
  drop under 180 px. Click a tile to make it active, double-click its header
  (or ⌥Z) to zoom to single on it and back. Cheap: there is one xterm per
  proc regardless, grid is a layout change plus fitting every visible
  terminal instead of just the active one.
- **http** — the traffic view ([http-observability.md](http-observability.md)).
- **merged** (reserved, not built) — one chronological stream of every
  proc's lines with `[id]` prefixes. A line list, not xterm; it would read
  the server's line buffers. Lower value here than in foreman-style tools —
  badges and panes already answer "did something break", merged only answers
  "in what order across procs". Built when that itch is real.

Chrome: a **global bar** holds only deck-wide things — deck name (the deck
switcher), layout switch, ⌘F search, "↻ all" / "■ all", theme, install, ⏻.
Every pane has its own **header** (dot, id, badges, addresses, status, and
↻ ■/▶ ⌫ buttons that fade in on hover) in every layout, so "what I see is
what I act on" holds in grid too.

Rules that hold in every mode, so merged slots in later without churn:

- There is always exactly one **active** proc; ⌥R/⌥S and ⌘K/⌘F act on it.
  Grid marks it with a frame; merged would make `[id]` prefixes clickable.
- ⌘F/⌘K are routed through `update.ts` as Commands — single/grid implement
  them with the xterm addons, merged would implement them over lines.
- Unread-error badges count lines landing in a non-active pane, whatever the
  layout; in grid they sit on the tile headers.
- Nothing new may assume "output only exists inside xterm".

Hotkeys are modifier-only on purpose — bare keys and bare Ctrl belong to the
PTY.

## Grid pinning and the tray

Nine panes on one screen is the reality on a monorepo deck; a scrolling grid
hides exactly the crash below the fold. Patterns that survive elsewhere
(tmux status bar, macOS minimise, Grafana's fit-vs-scroll) led to:

- **Pin + tray.** `pinned` (persisted) is the set of procs the user wants in
  the grid; empty means everyone. Pin toggles live on the pane header, the
  sidebar row (hover-revealed) and the tray chips; ⌥P toggles the active
  pane. Unpinned procs collapse into the **tray** under the grid — dot, id,
  badges — click a chip to peek (single on it), pin to put it back. The
  active pane may sit in the tray; it keeps its accent there because hotkeys
  still act on it. Stale pins are dropped when the proc list arrives, like a
  stale `active`.
- **Fit without a toggle.** The column rule above was enough; font scaling
  was not needed — pins are the pressure valve.
- **Groups as sections.** A proc's `group` from the config is a section
  label in the sidebar (ungrouped procs first, then each group in order of
  first appearance — the same shape `procdeck status` prints). Collapsible
  grid sections were considered and not built: pins cover the grid.

## State that survives a reload

`layout`, `active`, `theme`, `pinned` and the notifications toggle persist in
**localStorage** (`ui/src/storage.ts`). It is the right store: keyed per
origin, and origin includes the port, so every deck keeps its own state with
no namespacing. Every field is optional on read, so an old or hand-edited
record never blanks the UI. One `SaveUiState` Command, appended by a wrapper
around `update` whenever a persisted field changed — no branch can forget it.
Never persisted: `unread`, `mounted`, `search`.

Rejected: the URL hash (`#api`) — back-button and sharing semantics are not
worth routing for two fields; server-side — outlives the browser but not the
deck, and it is a disk write for two fields.

## Theme

System · Light · Dark in the global bar, defaulting to System via
`prefers-color-scheme`. The preference and the OS state are separate Model
fields (the matchMedia subscription is always on, so switching back to
System is current). CSS tokens are dark on `:root`, light under the media
query (guarded against an explicit dark) and under `[data-theme="light"]`.
What CSS cannot reach — xterm palettes, the theme-color meta, the attribute —
is one `ApplyTheme` Command from the same `update` wrapper. An inline script
in `index.html` reads the same localStorage record before the first frame, so
there is no flash. Not done: the generated manifest's `theme_color` is still
dark; the runtime meta overrides it in Chromium.

## Attention: title, favicon, notifications

`attentionCount` = crashed (non-zero exit or signal — a clean `exit 0` is not
an alarm) + blocked + alerting + procs with unread errors. It prefixes the
title (`(2) garage · procdeck`) and swaps the favicon. Desktop notifications
are opt-in (the bell, persisted), fire on _transitions_ only (a fresh crash,
block or alert) and only for live events — replayed history never notifies —
and stay quiet while the tab is visible and focused. A tag per proc collapses
repeats.

## Reconnecting

The SSE feed's health is a Model field: `connecting` until the first open (no
banner — the page is still loading), `reconnecting` after a drop (a strip
overlaying the top of the work area, so nothing shifts). The first open after
a drop refetches the proc list; the replay then brings every pane back (see
[log-buffers.md](log-buffers.md)). EventSource retries on its own while the
server is unreachable; once it gives up, the subscription retries every 2 s.
When the deck was shut down, the banner says so and names the root
(`procdeck up` in …), and the page revives itself when the feed is back.

## Installable app

A per-deck manifest generated by the server (`name` from the config, else the
config directory's basename — every deck is its own origin, so its own Dock
icon), an "⤓ install" button driven by `beforeinstallprompt` (Chromium; Safari
users go File → Add to Dock). No service worker on purpose: a cached dev-tool
UI goes stale. The payoff needs [the daemon](daemon.md) — an icon for a deck
that dies with its terminal is half a feature.
