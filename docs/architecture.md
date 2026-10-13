# Architecture

How procdeck is put together, for anyone reading or changing the code.

| Path          | What                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `main.go`     | The `procdeck` command.                                                                                                    |
| `internal/`   | Everything else in Go — packages the compiler keeps private to this module.                                                |
| `ui/`         | [Foldkit](https://foldkit.dev) (Elm-on-Effect) app; vite builds it straight into `internal/webui`, embedded in the binary. |
| `e2e/`        | Black-box suites (vitest) driving the built binary: the CLI, the HTTP observer, an MCP session.                            |
| `npm/`        | The npm distribution: the launcher package, and `build.mjs` assembling the per-platform packages at release.               |
| `example/`    | A self-contained demo stack (Node one-liners) exercising every feature.                                                    |
| `schema.json` | The config's JSON Schema for editors; `TestSchemaMatchesTheStructs` keeps it in step with `internal/config`.               |

## The deck

| Package               | What                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `internal/proc`       | PTY spawn (`creack/pty`), process-group kill, SIGTERM → SIGKILL escalation, preflight checks.                                       |
| `internal/config`     | The config types, the JSONC loader (`tailscale/hujson`), validation, `${port}` templating.                                          |
| `internal/dotenv`     | `envFile`: the dotenv format `node --env-file` reads.                                                                               |
| `internal/supervisor` | Per-proc state behind one mutex: lifecycle, port assignment, readiness, preflight gates, alerts, the backlog and the SSE fan-out.   |
| `internal/ports`      | Free-port allocation, and one `ps` + `lsof` per poll for every running tree's listening ports.                                      |
| `internal/server`     | `net/http`: the API under `/__procdeck/api`, SSE downstream, POST upstream, the `Host`-routed `*.localhost` proxy, the embedded UI. |
| `internal/deck`       | One deck in this process: bind the UI port, start the supervisor, serve, register — and tear it down in reverse.                    |
| `internal/registry`   | `~/.procdeck/instances/<id>.json` per running deck: how `down`/`ls`/the deck switcher find decks. Byte-compatible with 1.x.         |
| `internal/initplan`   | `procdeck init`: workspace scan → a first config.                                                                                   |
| `internal/webui`      | `go:embed` of the UI build.                                                                                                         |
| `internal/cli`        | The `cobra` command tree; `up --fg` is the deck, everything else talks to the registry and the API. Detaching lives here too.       |

## The agent harness

| Package               | What                                                                                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `internal/lines`      | Per-proc **line** buffers: ANSI stripped, `\r` progress bars reduced to their final state, byte-bounded, `seq`-cursored. The machine-readable twin of the terminal chunk backlog. |
| `internal/deckclient` | The client for a running deck's HTTP API — one implementation of "ask the deck", used by both front doors.                                                                        |
| `internal/errscan`    | Heuristic error extraction over the line buffers: find an error's first line, attach its frames, deduplicate by signature.                                                        |
| `internal/mcpserver`  | `procdeck mcp` on the official Go SDK: the same verbs as MCP tools over stdio. Read-only unless `--mutations`.                                                                    |
| `internal/discover`   | `procdeck agents`: the `## procdeck` section in CLAUDE.md / AGENTS.md and the Claude Code skill, embedded verbatim.                                                               |

## The traffic observer

| Package              | What                                                                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `internal/httplog`   | One byte-bounded ring of captures per proc — the traffic twin of `internal/lines`. Body tees, header redaction, the query and the digest.                                                           |
| `internal/interpose` | The capture-aware forwarding shared by both interception points: the `*.localhost` proxy, and the per-proc observer that listens on the public assigned port and forwards to a hidden internal one. |
| `internal/wsframe`   | RFC 6455 frame parsing over the raw socket bytes after a 101, so WebSocket messages land in the same rings.                                                                                         |

## Design notes worth keeping

- **One binary.** The UI is built by vite and embedded with `go:embed`; the
  binary carries the UI it was built with, and there is nothing to install
  next to it. npm ships a launcher plus one `@procdeck/<os>-<arch>` package
  per platform as optional dependencies — no install scripts.
- **One mutex, published under it.** The supervisor's state sits behind a
  single mutex, and events are published while it is held. A new subscriber's
  snapshot (every proc's backlog and status, then `synced`) and its live feed
  therefore meet with no gap and no duplicate. Slow work — terminating a tree,
  a preflight, asking the OS for ports — happens outside it; a per-proc lock
  keeps start/stop/restart of one proc from interleaving.
- **SSE, not WebSocket.** Logs only flow towards the browser; commands are
  ordinary POSTs. No upgrade handshake, and `EventSource` reconnects by itself.
- **Two buffers per proc, on purpose.** The chunk backlog is terminal-oriented
  (raw PTY bytes, replayed into xterm); the line buffer is machine-oriented
  (clean text, timestamps, a stable cursor). One would have to lie to the other.
- **Readiness is a channel.** Open while a proc is not ready, closed when it
  is — every waiting dependent wakes at once — and replaced when it stops
  being ready. A launch waiting on `needs` is a goroutine with a context;
  stopping the proc cancels it, and the same context interrupts its preflight.
- **Teardown is `defer`.** The deck acquires in order — the UI port, the
  supervisor, the server, the registry entry — and releases in reverse.
  Ctrl-C, `procdeck down` and the UI's ⏻ are all the same SIGTERM.
- **Detached is just `up --fg` in the background.** No daemon, no IPC: `up`
  re-runs its own binary in a new session with its output in a log file, and
  waits for the child's registry entry — written only after the port is bound
  — so "up" means reachable. The registry is plain files pruned by pid; every
  deck serves its own UI, and the deck switcher is a list of links.
- **The observer is the port assignment.** Because procdeck already hands out
  `${port}`, it can stand on the public port and give the proc a hidden one.
  That is what makes server-to-server traffic visible without asking the app
  for anything. Not `httputil.ReverseProxy`: its upgrade path cannot be tapped.

## Tests

```sh
pnpm test    # go test -race ./..., then the e2e suites against a fresh build
```

Integration tests with real (tiny) processes — shells with background
children, the Go test binary re-run as a helper server — because the risks
live at the OS boundary: PTY detection, group kills, SIGTERM-ignoring
survivors, teardown. Mocking any of that would test the mock. The e2e suites
in `e2e/` drive the binary from the outside, the way a user and an agent do.

They need a real PTY (`/dev/ptmx`), so they will not run inside sandboxes that
block PTY allocation.

## Conventions

- Go: `gofmt` and `go vet`. TypeScript (`ui/`, `e2e/`): `oxlint` and `oxfmt`
  (no semicolons, no trailing commas). `pnpm lint` and `pnpm format` run both.
- The Effect language service is patched into `tsc` by the root `prepare`
  script, so `pnpm check:types` reports Effect diagnostics for the UI too.
- User-facing prose for config fields lives in `schema.json` — what editors
  show. A field added to `internal/config` needs its entry there.
