# Config reference

A deck is one config file: the UI's settings and the processes it supervises.
Two formats, one schema — `schema.json` is generated from the same Effect
`Schema` that validates the config at runtime, so JSON and TypeScript accept
exactly the same fields and give the same editor tooltips.

When no path is given, procdeck takes the first of these it finds, walking up
from the current directory:

```
procdeck.config.json
procdeck.config.ts
procdeck.config.js
procdeck.config.mjs
```

That is why every command works from any subdirectory of the project. Pass a
path to use another file: `procdeck up decks/backend.json`.

## JSON

Needs nothing from your toolchain — no TypeScript, and procdeck does not have
to be a dependency. Point `$schema` at the published schema and the editor
completes and validates every field:

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

Installed locally, `"./node_modules/procdeck/schema.json"` works too and needs
no network.

## TypeScript

Buys comments and computed configs, at the price of Node ≥ 22.18 (native type
stripping) and procdeck in your dependencies:

```ts
import { defineConfig } from "procdeck"

export default defineConfig({
  port: 4820,
  procs: [{ id: "api", shell: "pnpm --filter api dev", env: { PORT: "${port}" } }]
})
```

## Top level

| Field     | Type         | Default                 | What                                                                                                                      |
| --------- | ------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `procs`   | `ProcSpec[]` | required                | The processes this deck supervises.                                                                                       |
| `name`    | `string`     | config directory's name | Deck name: the tab title and the name of the installed web app.                                                           |
| `port`    | `number`     | `4820`                  | Port for the web UI and the `*.localhost` proxy.                                                                          |
| `host`    | `string`     | `"127.0.0.1"`           | Interface the UI and proxy bind to. Loopback only by default — the UI types into real terminals. `"0.0.0.0"` opens it up. |
| `$schema` | `string`     | —                       | URL of the JSON schema, for editor completion. Ignored at runtime.                                                        |

## A proc

| Field       | Type                        | Default               | What                                                                                                                 |
| ----------- | --------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`        | `string`                    | required              | Pane label and proxy subdomain: `api` → `http://api.localhost:4820`.                                                 |
| `shell`     | `string`                    | —                     | Command line handed to `$SHELL -c`: pipes, `&&` and globs work. Exactly one of `shell` / `cmd`.                      |
| `cmd`       | `string[]`                  | —                     | argv, executed directly without a shell. One process less in the tree.                                               |
| `cwd`       | `string`                    | config's dir          | Working directory.                                                                                                   |
| `env`       | `Record<string, string>`    | —                     | Extra environment on top of the inherited one. Values may use `${port}` templates.                                   |
| `autostart` | `boolean`                   | `true`                | `false` leaves the pane idle until someone presses Start.                                                            |
| `url`       | `string`                    | —                     | URL this process serves, shown as a link in the UI. Also pins readiness to that URL's port.                          |
| `port`      | `number`                    | random free           | Pin the assigned `${port}` to this exact public number. See [Assigned ports](#assigned-ports).                       |
| `needs`     | `string[]`                  | —                     | Ids that must be ready before this proc spawns.                                                                      |
| `readyWhen` | `"listening" \| "started"`  | `"listening"`         | What "ready" means for dependents: a listening TCP port, or merely spawned (for procs that never listen).            |
| `observe`   | `boolean`                   | `true` with `${port}` | Route the assigned port through the HTTP observer so `procdeck http` sees the traffic. See [traffic.md](traffic.md). |
| `preflight` | `{ shell, expect?, hint? }` | —                     | A gate that must pass before the process spawns.                                                                     |
| `alerts`    | `{ pattern, label }[]`      | —                     | Output regexes that raise a badge in the UI.                                                                         |

Duplicate ids, unknown `needs` targets and dependency cycles are rejected when
the config loads, with the offending name in the message.

## Assigned ports

`${port}` anywhere in `shell`, `cmd`, an `env` value or `url` means "procdeck,
give this proc a free port". It is substituted before the process spawns, and
the proc also gets `PORT` in its environment.

`${port:api}` is _another_ proc's assigned port — that is how dependents get
wired without a single hardcoded number:

```jsonc
{ "id": "api", "shell": "pnpm --filter api dev", "env": { "PORT": "${port}" } },
{
  "id": "web",
  "shell": "pnpm --filter web dev",
  "env": { "API_URL": "http://localhost:${port:api}" },
  "needs": ["api"]
}
```

Ports are assigned once per run, so nothing can collide. A `${port:x}` that
names a proc which does not use `${port}` itself is a config error.

A spec-level `port` pins the assignment to a fixed number instead of a random
free one:

```jsonc
{ "id": "api", "shell": "pnpm --filter api dev --port ${port}", "port": 8787 }
```

The public side stays exactly `8787` — dotenv files, mobile simulators and
teammates' scripts keep their hardcoded `localhost:8787` — while the proc
itself still binds a hidden internal port behind the HTTP observer, so the
traffic is captured with no wiring changes anywhere. And a colleague who runs
the dev script *without* procdeck lands on the same address: the process
simply binds its own default port directly.

A pin on a proc that never uses `${port}`, two procs pinning the same number,
and a pin on the UI's own port are config errors. A pin whose port is already
taken — usually the same service still running outside procdeck — parks just
that proc in `blocked`, naming the port and the likely holder, while the rest
of the deck runs; free the port and press Start, and the bind is retried.

## Readiness and dependencies

`needs: ["api"]` parks a proc in `waiting` until every dependency is ready.
Ready means the process _tree_ opened a TCP port — detected by a 1s
`pgrep` + `lsof` poll, so the process needs to cooperate in no way at all. A
proc with `url` is pinned to that URL's port: a stray port opened by some
child does not count as ready.

Processes that never listen (queue workers, watchers) declare
`readyWhen: "started"`.

## Preflight gates

```jsonc
{
  "id": "api",
  "shell": "wrangler dev",
  "preflight": {
    "shell": "wrangler whoami",
    "expect": "You are logged in",
    "hint": "run `wrangler login`, then Start"
  }
}
```

The gate runs before the process spawns; a non-zero exit — or output that does
not match `expect` — parks the pane in `blocked` with the output and the hint.
`expect` exists for checks that exit 0 either way (`wrangler whoami` reports
"not authenticated" quite cheerfully), so configs need no `| grep` pipelines.

This keeps interactive auth flows out of supervised panes, where a restart
would kill an OAuth callback server mid-handshake.

## Alerts

```jsonc
"alerts": [{ "pattern": "ERROR|not authenticated", "label": "needs login" }]
```

Regexes matched against a rolling tail of the pane's output. A match raises a
badge in the UI, counts into the tab title, and shows up in `procdeck status`'s
`attention` list — the first thing an agent reads.

## Tips

- Give tools that auto-increment on a busy port (vite) a `strictPort` flag, so
  a violated port assignment fails loudly instead of drifting.
- A good pattern for app dev scripts: `vite dev --port ${PORT:-3000} --strictPort`
  — a fixed default when run by hand, the assigned port under procdeck.
- The `*.localhost` proxy is for humans and browsers. Scripts and
  server-to-server calls should use the injected env (`${port:api}`): system
  resolvers do not all know `*.localhost`.
