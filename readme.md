# procdeck

[![npm](https://img.shields.io/npm/v/procdeck)](https://www.npmjs.com/package/procdeck)
[![Build](https://github.com/kondaurovDev/procdeck/actions/workflows/build.yml/badge.svg)](https://github.com/kondaurovDev/procdeck/actions/workflows/build.yml)

Run your whole dev stack with one command — and actually see what it's doing.

![The example stack in procdeck: six processes tiled, every pane a live terminal, every service on its own *.localhost address, the flaky one flagged](https://raw.githubusercontent.com/kondaurovDev/procdeck/main/docs/screenshot.webp)

procdeck is four tools in one ~2 MB package — the process runner, the port
allocator, the log viewer and the network tab of your dev environment:

- **Runs everything.** Every proc is a real terminal in a browser tab — and
  your own terminal is free again.
- **Hands out ports.** `${port}` is a free port, wired to whoever needs it —
  no hardcoded numbers, no collisions — and `api.localhost:4820` always
  reaches the right one.
- **Sees the traffic.** The HTTP and WebSocket requests _between_ your
  services — the half a browser's DevTools never shows.
- **Answers from the CLI.** `procdeck logs --since-mark fix`, `http --digest`,
  `status --json` — for you, or for a coding agent over MCP.

## Quick start

```sh
npx procdeck init     # writes procdeck.config.json from your workspace's dev scripts
npx procdeck          # starts the deck in the background and opens the UI
```

The UI opens at <http://localhost:4820> and your terminal is free again.
`procdeck down` stops everything. Requires **Node ≥ 22**, macOS or Linux.

Prefer it in the project (and you do, if you want the config in TypeScript):

```sh
pnpm add -D procdeck      # npm i -D procdeck · bun add -d procdeck
```

> **Install footprint.** ~2 MB, one dependency. The server ships as a bundle,
> so nothing but the PTY bindings is installed — and those are
> [`@lydell/node-pty`](https://github.com/lydell/node-pty): the same sources as
> [node-pty](https://github.com/microsoft/node-pty), as per-platform packages.
> Nothing compiles and no install script runs, so there is no
> `pnpm approve-builds` detour and no compiler needed on Linux.

## What you get

- **Terminal panes in the browser.** Every process runs in a real PTY and
  renders in xterm.js — colours, spinners, cursor redraws and interactive
  hotkeys all work. Single pane with a sidebar, or every pane tiled (⌥G); pin
  the ones you watch and the rest collapse into a tray.
- **Ports that never collide.** Write `${port}` in a command, env value or url
  and procdeck assigns a free port before spawning. `${port:api}` is another
  proc's port, so dependents get wired — `API_URL=http://localhost:${port:api}`
  — with no hardcoded numbers anywhere.
- **A memorable address for each service.** `api.localhost:4820`,
  `web.localhost:4820` — whatever port the process actually got. Browsers
  resolve `*.localhost` themselves, so there is zero system setup, and
  WebSocket upgrades (vite HMR) pass through.
- **Dependencies that mean something.** `needs: ["api"]` parks a proc until the
  API is actually listening — detected from the OS, with no cooperation from
  the process. `preflight` gates a proc behind a check that must pass first
  (`wrangler whoami`), so interactive logins stay out of supervised panes.
- **It tells you when something breaks.** Crashes, blocked procs and alert
  patterns raise a badge, count into the tab title and can fire a system
  notification while the tab is hidden.
- **Clean restarts.** `pnpm` → `wrangler` → `workerd`: procdeck signals the
  whole process group, escalating SIGTERM → SIGKILL, so nothing is left holding
  a port.
- **Out of your terminal's way.** `procdeck up` runs detached; `down`,
  `status`, `logs`, `restart` and `open` work from any subdirectory of the
  project. `procdeck ls` lists every deck on the machine.
- **Installable as an app.** The UI ships a web-app manifest named after the
  deck, so "⤓ install" gives each project its own window and Dock icon.

## Traffic, not just logs

Procs that use `${port}` get an HTTP observer on their assigned port, so
procdeck sees the requests _between_ your services — the half a browser's
DevTools never shows:

```sh
procdeck http --digest        # 4xx/5xx grouped by route, with counts
procdeck http api --body      # bodies (text only, auth headers redacted)
```

WebSocket messages land in the same view, and ⇄ in the UI is the network tab
for your processes:

![The traffic view: every request between the example's services with method, status, timing and size, filterable by proc](https://raw.githubusercontent.com/kondaurovDev/procdeck/main/docs/screenshot-http.webp)

See [docs/traffic.md](https://github.com/kondaurovDev/procdeck/blob/main/docs/traffic.md).

## For coding agents

An agent edits code, but the consequences land in processes it cannot see.
procdeck already owns those processes, so it can answer:

```sh
procdeck mark before-fix              # a marker at "now"
procdeck restart api && procdeck wait-for api
procdeck logs --since-mark before-fix # only what the change caused
procdeck http --since-mark before-fix # only the requests it caused
```

Everything takes `--json` and is bounded by default. The same verbs are served
over MCP — `claude mcp add procdeck -- procdeck mcp`, once, globally: the
instance registry finds the right deck per project. `procdeck agents` writes
the discovery section into CLAUDE.md / AGENTS.md.

See [docs/agents.md](https://github.com/kondaurovDev/procdeck/blob/main/docs/agents.md).

## Commands

```sh
procdeck init               # write procdeck.config.json from what the project already says
procdeck up [config]        # start (detached) and open the UI — idempotent
procdeck down               # stop: every process tree is terminated
procdeck restart [proc]     # one proc, or the whole deck; --all for every deck on this machine
procdeck status             # address, uptime, every proc's state (--json for agents)
procdeck ls                 # every running deck on this machine
procdeck open               # open the UI — no port to remember
procdeck logs [proc]        # pane output as plain lines; --grep, --since, --since-mark
procdeck http [proc]        # captured HTTP and WebSocket traffic
procdeck errors [proc]      # stack traces, deduplicated
procdeck up --fg            # foreground instead: Ctrl-C stops the deck
```

`procdeck` alone is `procdeck up`. Without a config path, the nearest
`procdeck.config.{json,ts,js,mjs}` above the current directory is used.

Running decks register in `~/.procdeck/instances/` (one JSON per deck, pruned
by pid) and a detached deck's own output goes to `~/.procdeck/logs/`. Updating
procdeck needs a `procdeck restart` — the running deck keeps the old code until
then, and `status` says so out loud when the versions differ.

The server binds **127.0.0.1 only**: the UI types into real terminals, so it is
not something to put on the LAN by accident. `"host": "0.0.0.0"` opens it up
for a devcontainer or a VM. No telemetry, no service worker.

## Config

```jsonc
{
  "$schema": "https://unpkg.com/procdeck/schema.json",
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

JSON needs nothing from your toolchain — no TypeScript, and procdeck does not
have to be a dependency. TypeScript configs buy comments and computed values:

```ts
import { defineConfig } from "procdeck"

export default defineConfig({
  procs: [{ id: "api", shell: "pnpm dev", env: { PORT: "${port}" } }]
})
```

Both formats validate against the same schema. Full field reference:
[docs/config.md](https://github.com/kondaurovDev/procdeck/blob/main/docs/config.md).

## Try the example

In a clone of this repo:

```sh
pnpm install
pnpm dev          # builds the UI, starts the example stack in the foreground
```

Then open <http://localhost:4820> for the panes, and
<http://web.localhost:4820> / <http://api.localhost:4820> — the example's
servers found each other, and their own ports, entirely through `${port}`
templates. See [`example/`](https://github.com/kondaurovDev/procdeck/tree/main/example).

## Docs

| Doc                                                                                        | What                                                   |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| [config.md](https://github.com/kondaurovDev/procdeck/blob/main/docs/config.md)             | Every config field, port templating, readiness, gates. |
| [agents.md](https://github.com/kondaurovDev/procdeck/blob/main/docs/agents.md)             | The verify loop, the CLI verbs, the MCP tools.         |
| [traffic.md](https://github.com/kondaurovDev/procdeck/blob/main/docs/traffic.md)           | What the HTTP observer captures, and what it cannot.   |
| [architecture.md](https://github.com/kondaurovDev/procdeck/blob/main/docs/architecture.md) | How the code is put together.                          |
| [design/](https://github.com/kondaurovDev/procdeck/tree/main/docs/design/)                 | Engineering notes behind the bigger features.          |

## Status

**macOS and Linux.** Port discovery asks the OS through `pgrep` + `lsof`, and
a whole-tree restart signals the process group (`kill(-pid)`) — both POSIX.
Windows works through WSL, not natively.

**Missing on purpose.** A dependency dying does _not_ cascade to its
dependents: procdeck tells you and leaves the decision to you. And nothing is
injected into the apps you develop — no overlay, no script tag, no agent in
your page.

Patches welcome — see
[contributing.md](https://github.com/kondaurovDev/procdeck/blob/main/contributing.md).
The UI types into real terminals, so it is worth knowing what that implies and
what the traffic observer keeps:
[security.md](https://github.com/kondaurovDev/procdeck/blob/main/security.md).

MIT.
