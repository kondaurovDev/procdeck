# Plan

What is agreed on and not built, roughly by value over effort. Decisions
behind shipped features live in [design/](design/); this file only shrinks.

## Web UI

- **Collapsible grid sections per `group`** — the sidebar has sections
  already; the grid shows one flat set of tiles. Worth it once a deck has
  more groups than pins comfortably handle.
- **Status filter chips** in the global bar — running / exited / alerts
  (Docker Desktop, k9s). Cheap; answers "show me only what's broken".
- **Terminal niceties** — ⌘+/⌘− font size, copy-on-select, a wrap toggle, a
  "send Ctrl-C" action (stop signals the whole group; sometimes you want a
  plain ^C as in a terminal).
- **Command palette** (⌘P) — jump to proc, start/stop/restart, pin, theme.
  Hotkeys are modifier-only and invisible; the palette makes them
  discoverable. Worth building once there are enough actions to put in it.
- **Merged view** — the fourth position of the layout switch
  ([design/ui.md](design/ui.md) has the rules it must follow). Reads the
  server's line buffers, not xterm scrollback.
- **Line filter (grep mode)** — show only lines matching a pattern. xterm
  cannot hide lines, so this is a filtered view over the line buffers, not an
  xterm feature; pairs with the merged view.
- **Copy / download logs** — "copy visible" and "download full log".
- **CPU / memory per proc** in the sidebar — the port poller already walks
  every process group once a second; `ps` can ride along.
- **Timestamps toggle** — prefix each line with wall-clock time.
- **Drag-to-reorder** and **⌥1…⌥9** (jump to the N-th proc) — nice-to-have,
  not before pins have proven insufficient.
- The generated manifest's `theme_color` is dark whatever the theme; only
  the install dialog notices.

## CLI

- `logs --until` to pair with `--since` — the server already takes
  `untilMs`; it was only reachable through the removed MCP `timeline` tool.
- A `--port` override on `up`, for a one-off second deck of the same
  project.
- `logs --follow` is there; `http --follow` is not.

## Publishing

- A hero GIF right under the README title — a healthy deck, not a wall of
  red stacks.
- A "vs mprocs / overmind / concurrently / turbo TUI" table — that is where
  users come from.
- An "update available" hint in the global bar (a daily version check) —
  with the daemon, an upgrade needs an explicit `procdeck restart`.
