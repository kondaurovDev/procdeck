# The deck as a daemon

procdeck 1.0 was a foreground process: the terminal tab it ran in was the only
lifecycle handle, and a tab stayed open just to keep the deck alive. That made
the installed web app half a feature — a Dock icon for something that dies
with its terminal. Two decisions fixed it: the deck detaches by default, and
running decks register themselves so every command can find them.

## Detached by default

`procdeck up` (and bare `procdeck`) re-runs its own binary as
`up --fg --no-open <config>` in a new session (`Setsid`), with stdout and
stderr in `~/.procdeck/logs/<id>.log`, and lets go of it
(`internal/cli/daemon.go`). The child knows it is the daemon through
`PROCDECK_DETACHED=1`, which only changes what it writes into the registry.

The parent does not return on spawn. It polls the registry until an entry
with the child's pid appears — written after the server is listening — or
the child exits, or 20 s pass; in the failure cases it prints the log's tail.
So `up` returns only when the UI is reachable, and a bad config or a busy
port surface in the terminal, not in a log file nobody reads. The parent also
loads the config and probes the UI port itself before spawning anything.

`up` is idempotent: in a project that is already up it prints "already up",
the pid, and opens the browser. `--fg` is the old behaviour — Ctrl-C stops the
deck, a second Ctrl-C (past a 250 ms echo window, because npm shims pass the
first signal on) forces it. The daemon's log is appended to across runs and
rotated once past 4 MB, one previous generation kept.

Shutdown is one path for everyone: `procdeck down`, the UI's ⏻ button
(`POST /shutdown`, which answers 200 and then signals its own process) and
Ctrl-C all end in SIGTERM → terminate every process tree → deregister. `down`
waits up to 30 s, then SIGKILLs; the stale registry entry is pruned on the
next read.

Known cost, accepted: updating procdeck's binary needs `procdeck restart`
(or `restart --all`), which restarts every pane. `status` and `ls` say so out
loud when a deck's version differs from the CLI's.

## The instance registry

One deck per project, one port per deck. With several projects detached,
ports should not have to be memorised, and `down` needs a pidfile anyway —
the registry is both (`internal/registry`).

- A deck writes `~/.procdeck/instances/<id>.json` once it is listening: name,
  root, config path, port, pid, log path, startedAt, version, mode. `id` is
  the sha1 of the **real** root path — symlinks resolved, because macOS hands
  out `/var/…` for `/private/var/…` and one project must not become two.
- Plain files, no central daemon. Readers drop entries whose pid is gone, so
  a crashed deck never lingers. `PROCDECK_HOME` relocates the tree (tests,
  sandboxes). The format is shared with 1.x; either version can list and stop
  the other's decks.
- Every command that needs the deck (`down`, `status`, `open`, `logs`,
  `start`, …) locates the config walking up from the cwd — the way git finds
  its root — and looks the root up. `ls` lists every live deck, with the
  running count fetched from each deck's API.
- `up` refuses a port already held by another deck (naming it and its root)
  and a port that is simply busy, before spawning.

## Decision: one installed app per project, the switcher is navigation

The UI lists every live deck (`GET /instances`, the deck name in the global
bar is the dropdown) as plain `http://localhost:<port>` links. An installed
web app is bound to its origin, and origin includes the port — the "garage"
window _is_ `localhost:4820`; navigating it elsewhere leaves the app's scope.
"One Dock icon with a deck switcher inside" would need a hub proxying every
deck under one origin, which is the split rejected below. So: one Dock icon
per project, which matches one-deck-per-monolith and PWA scoping; the deck
name stays in the title (Dock and ⌘Tab need it); the switcher is links.

## Decision: keep the UI embedded, no daemon/cockpit split

A separate cockpit talking to headless daemons buys one thing — a single
memorable address — at the cost of CORS and SSE proxying, cockpit↔daemon
version skew and a second lifecycle. The `*.localhost` proxy already pins a
port per deck, and the registry gives every deck's UI the list of the others.
If a stable address is ever wanted, a tiny fixed-port page that reads the
registry and redirects is enough — a page, not a backend. Out of scope: a
view mixing panes of several decks (needs SSE proxying).
