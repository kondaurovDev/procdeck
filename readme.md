# procdeck

An interactive dev-process multiplexer with a **web UI** instead of a TUI — the thing
`mprocs`/`overmind` do, but the panes live in a browser tab, and the tool also solves
the two problems terminal multiplexers can't touch: **port conflicts** and **remembering
which port is which**.

```
┌──────────┬───────────────────────────────────────────────┐
│ ● api    │  Restart  Stop  Start   api.localhost:4820    │
│ ● web    ├───────────────────────────────────────────────┤
│ ● clock  │  $ node servers/api.mjs                       │
│ ● flaky ⚠│  api listening on :52341                      │
│          │  GET /                                        │
└──────────┴───────────────────────────────────────────────┘
```

## What it does

- **Terminal panes in the browser.** Every process runs in a real PTY and renders in
  xterm.js — colours, spinners, cursor redraws and interactive hotkeys work exactly like
  in a terminal. Keystrokes are posted back into the PTY.
- **Assigned ports.** Write `${port}` in a proc's command, env or url and procdeck hands
  it a free port before spawning (also exported as `PORT`). `${port:api}` references
  another proc's assigned port — so dependents get wired
  (`API_URL=http://localhost:${port:api}`) without a single hardcoded number. Nothing
  can conflict: ports are assigned once per run and never collide.
- **A reverse proxy on `*.localhost`.** Every pane is reachable at a stable, memorable
  address on the UI's own port — `api.localhost:4820`, `web.localhost:4820` — whatever
  port the process actually got. Browsers hardcode `*.localhost` → 127.0.0.1, so there
  is zero system setup. WebSocket upgrades pass through (vite HMR works); the `Host`
  header is rewritten upstream so host-allowlisting dev servers need no config.
- **Port auto-detection.** A 1s poll asks the OS (`pgrep` + `lsof`) which TCP ports each
  process _group_ listens on; they render as links in the UI. No cooperation from the
  process needed.
- **Declarative dependencies.** `needs: ["api"]` parks a proc in `waiting` until every
  dependency is ready. Ready = "listening on its port" by default, or
  `readyWhen: "started"` for procs that never listen. Unknown names, duplicates and
  cycles are rejected by the config schema.
- **Preflight gates.** A shell command that must pass before the proc spawns (plus an
  optional `expect` regex for checks that exit 0 either way, like `wrangler whoami`).
  Failure parks the pane in `blocked` with the output and a hint for the human — keeps
  interactive auth flows out of supervised panes, where a restart would kill an OAuth
  callback server mid-handshake.
- **Alerts.** Regexes matched against a rolling tail of pane output; a match raises a
  badge in the UI ("needs login").
- **Knows when you're not looking.** Crashed, blocked or alerting procs and unread error
  lines count into the tab title (`(2) garage`) and a red dot on the favicon; turn on the
  bell and a crash or alert while the tab is hidden becomes a system notification.
- **Whole-tree restarts.** `pnpm` → `wrangler` → `workerd`: killing the pid would leave
  the grandchild holding the port. procdeck signals the process group, escalating
  SIGTERM → SIGKILL, and Ctrl-C tears down every tree it spawned.
- **Single or grid layout.** One pane at a time with a sidebar, or every pane tiled
  (⌥G, ⌥Z zooms one tile in and out); each pane header carries its address, status and
  restart/stop/clear. Too many tiles? **Pin** the ones you watch (📌, ⌥P) — the grid
  shows only those and the rest collapse into a tray strip with their status dots and
  badges, one click from a peek. Layout, pins, selected pane and theme (system / light /
  dark — terminals included) survive a reload.
- **Runs in the background.** `procdeck up` starts the deck, opens the UI and returns
  — no terminal tab kept hostage. `down`, `restart`, `status`, `logs` and `open` work
  from anywhere inside the project; `procdeck ls` lists every deck on the machine;
  ⏻ in the UI shuts one down. Prefer a terminal? `up --fg`.
- **Installable as an app.** The UI ships a web-app manifest named after the deck
  (`name` in the config, else the directory), so "⤓ install" in the bar — or File →
  Add to Dock in Safari — gives each project its own window and Dock icon. Works over
  plain `http://localhost`, no HTTPS needed. Several projects? The deck name in the
  bar lists the other running decks, one click away.

## Install

Nothing to install, if you don't want to — write a `procdeck.config.json` (see
[Config](#config)) and run:

```sh
npx procdeck                      # picks up ./procdeck.config.json
npx procdeck decks/backend.json   # or point it at any config file
```

The deck comes up in the background, the UI opens at <http://localhost:4820>, and the
terminal is yours again. Requires **Node ≥ 22**.

Or add it to the project, which is what you want if you keep the config in TypeScript:

```sh
pnpm add -D procdeck      # npm i -D procdeck · bun add -d procdeck
```

## Commands

```sh
procdeck up [config]        # start (detached) and open the UI — idempotent
procdeck down               # stop: every process tree is terminated
procdeck restart            # down + up — after editing the config or updating procdeck
procdeck status             # this project's deck: address, uptime, every proc's state
procdeck ls                 # every running deck on this machine
procdeck open               # open the UI — no port to remember
procdeck logs [-f]          # procdeck's own log (startup, shutdown, errors)
procdeck up --fg            # foreground instead: Ctrl-C stops the deck
```

`procdeck` alone is `procdeck up`. Without a config path, the nearest
`procdeck.config.{json,ts,js,mjs}` up from the current directory is used, so every
command works from any subdirectory of the project. Running decks register in
`~/.procdeck/instances/` (one JSON per deck — that is how `down`, `ls` and the UI's
deck switcher find them; stale entries are pruned by pid), and a detached deck's own
output goes to `~/.procdeck/logs/`. `--no-open` skips the browser. Updating procdeck
needs a `procdeck restart` — the running deck keeps the old code until then.

## Try the example

In a clone of this repo:

```sh
pnpm install
pnpm dev          # builds the UI, starts the example stack in the foreground
```

> **Install footprint.** ~2 MB, one dependency. The server is shipped as a bundle, so
> nothing but the PTY bindings is installed — and those are
> [`@lydell/node-pty`](https://github.com/lydell/node-pty): the same sources as
> [node-pty](https://github.com/microsoft/node-pty), distributed as per-platform packages.
> Nothing compiles and no install script runs, so there is no `pnpm approve-builds` /
> `trustedDependencies` detour, and no compiler is needed on Linux.

Open <http://localhost:4820> for the panes, then <http://web.localhost:4820> and
<http://api.localhost:4820> — the example's two servers found each other (and their own
ports) entirely through `${port}` templates. See [`example/`](example/).

## Config

Two formats, one schema. **JSON** needs nothing from your toolchain — no TypeScript, and
procdeck itself doesn't have to be a dependency. Point `$schema` at the published schema
and the editor completes and validates every field:

```jsonc
{
  "$schema": "https://unpkg.com/procdeck/schema.json",
  "port": 4820,
  "procs": [
    { "id": "api", "shell": "pnpm --filter api dev", "env": { "PORT": "${port}" } },
    {
      "id": "web",
      "shell": "pnpm --filter web dev",
      "env": { "PORT": "${port}", "API_URL": "http://localhost:${port:api}" },
      "needs": ["api"]
    }
  ]
}
```

(Installed locally, `"./node_modules/procdeck/schema.json"` works too and needs no
network.)

**TypeScript** buys comments and computed configs, at the price of Node ≥ 22.18 (native
type stripping) and procdeck in your dependencies:

```ts
import { defineConfig } from "procdeck"

export default defineConfig({
  port: 4820, // UI + proxy port
  procs: [
    {
      id: "api",                        // pane name and the proxy subdomain
      shell: "pnpm --filter api dev",   // or cmd: ["node", "server.js"]
      env: { PORT: "${port}" },         // ask procdeck for a free port
      preflight: {                      // gate: must pass before spawning
        shell: "wrangler whoami",
        expect: "You are logged in",
        hint: "run `wrangler login`, then Start",
      },
      alerts: [{ pattern: "ERROR", label: "check me" }],
    },
    {
      id: "web",
      shell: "pnpm --filter web dev",
      env: { PORT: "${port}", API_URL: "http://localhost:${port:api}" },
      needs: ["api"],                   // wait until api is listening
    },
    {
      id: "worker",
      shell: "node worker.js",
      readyWhen: "started",             // never listens; running = ready
    },
  ],
})
```

Full field reference: [`packages/procdeck/src/config.ts`](packages/procdeck/src/config.ts)
(the schema is the documentation — `schema.json` is generated from it at build time, so
the two formats validate identically). Config files are looked up in this order when no
path is given: `procdeck.config.json`, `.ts`, `.js`, `.mjs`.

Tips:

- Give tools that auto-increment on a busy port (vite) a `strictPort` flag, so a
  violated port assignment fails loudly instead of drifting.
- A good pattern for app dev scripts: `vite dev --port ${PORT:-3000} --strictPort` —
  fixed default when run by hand, assigned port under procdeck.
- The proxy is for humans and browsers. Scripts and server-to-server calls should use
  the injected env (`${port:api}`) — system resolvers don't all know `*.localhost`.

## How it fits together

| Path                    | What                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/procdeck/src` | The server: plain-Node PTY layer, Effect supervisor, HTTP/SSE server with the reverse proxy.          |
| `packages/procdeck/ui`  | [Foldkit](https://foldkit.dev) (Elm-on-Effect) app; built by vite, served statically by the server.   |
| `example/`              | Self-contained demo stack (Node one-liners) exercising every feature.                                 |

| File            | What                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `proc.ts`       | Plain Node: PTY spawn, process-group kill, SIGTERM → SIGKILL escalation.                             |
| `config.ts`     | Effect `Schema` for the config, `${port}` templating, loader.                                        |
| `supervisor.ts` | Effect layer: scoped lifecycle, port assignment, `PubSub` fan-out, per-proc state.                   |
| `ports.ts`      | Free-port allocation and `pgrep`+`lsof` listening-port discovery.                                    |
| `server.ts`     | `effect/unstable/http` router behind a small Node↔web-handler bridge; SSE downstream, POST upstream; `Host`-routed reverse proxy with WebSocket pass-through. |
| `registry.ts`   | `~/.procdeck/instances/<id>.json` per running deck: how `down`/`ls`/the deck switcher find decks.     |
| `lifecycle.ts`  | Detaching (`up` re-spawns itself as `up --fg` and waits for the registry entry), `down`, port probe.   |
| `cli.ts`        | `effect/unstable/cli` commands; `up --fg` is the server, everything else talks to the registry/API.    |

Design notes worth keeping:

- **Effect end to end.** The server is Effect; the UI is a Foldkit app — one Model (a
  Schema), pure `update`, side effects as Commands. Terminals are imperative islands via
  `Mount.defineStream`; PTY log chunks bypass the Model (`ReceivedLog` → `WriteTerminal`
  Command into a module-level terminal registry — the view never renders them); the SSE
  subscription is gated on a Model condition ("every pane mounted"), so the replayed
  backlog ordering is declarative, not sequenced by hand.
- **The server has no bundler.** It runs as `.ts` via Node type stripping (Node ≥ 22.18).
- **SSE, not WebSocket.** Logs only flow towards the browser; commands are ordinary
  POSTs. No upgrade handshake, no extra dependency, and `EventSource` reconnects by
  itself.
- **`PubSub.sliding({ capacity, replay })`** doubles as the fan-out to every open tab
  _and_ the scrollback ring buffer — a tab opened late replays the backlog for free.
- **The supervisor is `Effect.acquireRelease`.** Shutdown is not a code path anyone has
  to remember to call: closing the scope terminates every process tree. The SSE response
  stream lives in the request scope, so a dropped tab cleans up its subscription too.
  Ctrl-C, `procdeck down` and the UI's ⏻ are all the same SIGTERM into the same scope.
- **Detached is just `up --fg` in the background.** No daemon, no IPC: `up` spawns
  itself detached with its output in a log file, and waits for the child's registry
  entry to appear — written only after `listen` succeeds — so "up" means reachable.
  The registry is plain files pruned by pid; every deck serves its own UI, and the
  deck switcher is a list of links.

## Tests

```sh
pnpm test
```

Integration tests with real (tiny) processes — `node -e` one-liners and shells with
background children — because the risks live at the OS boundary: PTY detection, group
kills, SIGTERM-ignoring survivors, scope teardown. Mocking any of that would test the
mock. They need a real PTY (`/dev/ptmx`), so they won't run inside sandboxes that block
PTY allocation.

Gotcha: if every spawn fails with `posix_spawnp failed.`, the usual culprit is the
node-pty `spawn-helper` prebuild arriving without its execute bit (pnpm/Bun skipping
its install script). `proc.ts` restores the bit at import time, so this should
self-heal — if it still fails, PTY allocation itself is probably blocked (sandboxes).

## Status

A working prototype, macOS/Linux only (PTYs, `pgrep`, `lsof`). Known prototype-grade
shortcuts: the replay buffer counts events rather than bytes (a chatty proc can evict a
quiet one's history), and statuses are a mutated map rather than `SubscriptionRef`s.
Not done yet: an injected FAB overlay inside the developed apps, and a dependency-death
policy (a dependency dying does _not_ cascade — deliberately).
