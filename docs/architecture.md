# Architecture

How procdeck is put together, for anyone reading or changing the code.

| Path                    | What                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/procdeck/src` | The server: a plain-Node PTY layer, an Effect supervisor, an HTTP/SSE server with the reverse proxy and the traffic observer. |
| `packages/procdeck/ui`  | [Foldkit](https://foldkit.dev) (Elm-on-Effect) app; built by vite, served statically by the server.                           |
| `example/`              | A self-contained demo stack (Node one-liners) exercising every feature.                                                       |

## The server

| File            | What                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proc.ts`       | Plain Node: PTY spawn, process-group kill, SIGTERM → SIGKILL escalation.                                                                                      |
| `config.ts`     | Effect `Schema` for the config, `${port}` templating, the loader for both file formats.                                                                       |
| `supervisor.ts` | Effect layer: scoped lifecycle, port assignment, `PubSub` fan-out, per-proc state and buffers.                                                                |
| `ports.ts`      | Free-port allocation, and `pgrep` + `lsof` listening-port discovery for a process tree.                                                                       |
| `server.ts`     | `effect/unstable/http` router behind a small Node↔web-handler bridge: SSE downstream, POST upstream, `Host`-routed reverse proxy with WebSocket pass-through. |
| `registry.ts`   | `~/.procdeck/instances/<id>.json` per running deck: how `down`/`ls`/the deck switcher find decks.                                                             |
| `lifecycle.ts`  | Detaching (`up` re-spawns itself as `up --fg` and waits for the registry entry), `down`, port probe.                                                          |
| `init.ts`       | `procdeck init`: workspace scan → a first config.                                                                                                             |
| `cli.ts`        | `effect/unstable/cli` command tree; `up --fg` is the server, everything else talks to the registry/API.                                                       |
| `events.ts`     | The wire types shared by the server and the UI.                                                                                                               |

## The agent harness

| File                 | What                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lines.ts`           | Per-proc **line** buffers: ANSI stripped, `\r` progress bars reduced to their final state, byte-bounded, `seq`-cursored. The machine-readable twin of the terminal chunk backlog. |
| `agent/client.ts`    | Promise-based client for a running deck's HTTP API — one implementation of "ask the deck", used by both front doors.                                                              |
| `agent/errors.ts`    | Heuristic error extraction over the line buffers: find an error's first line, attach its frames, deduplicate by signature.                                                        |
| `agent/mcp.ts`       | `procdeck mcp`: the same verbs as MCP tools over stdio. Read-only unless `--mutations`.                                                                                           |
| `agent/discover.ts`  | `procdeck agents`: the `## procdeck` section in CLAUDE.md / AGENTS.md and the Claude Code skill.                                                                                  |
| `commands/agent.ts`  | The CLI verbs: `logs`, `mark`, `wait-for`, `errors`, `agents`, `mcp`.                                                                                                             |
| `commands/shared.ts` | Plumbing shared by every command: failures, config resolution, instance lookup, formatting.                                                                                       |

## The traffic observer

| File               | What                                                                                                                                                                                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http-log.ts`      | One byte-bounded ring of captures per proc — the traffic twin of `lines.ts`. Body tees, header redaction, the query and the digest.                                                                 |
| `interpose.ts`     | The capture-aware forwarding shared by both interception points: the `*.localhost` proxy, and the per-proc observer that listens on the public assigned port and forwards to a hidden internal one. |
| `ws.ts`            | RFC 6455 frame parsing over the raw socket bytes after a 101, so WebSocket messages land in the same rings.                                                                                         |
| `commands/http.ts` | `procdeck http`: the bounded tail, the filters, and `--digest`.                                                                                                                                     |

## Design notes worth keeping

- **Effect end to end.** The server is Effect; the UI is a Foldkit app — one
  Model (a Schema), a pure `update`, side effects as Commands. Terminals are
  imperative islands via `Mount.defineStream`; PTY log chunks bypass the Model
  (`ReceivedLog` → `WriteTerminal` Command into a module-level terminal
  registry — the view never renders them); the SSE subscription is gated on a
  Model condition ("every pane mounted"), so the replayed backlog ordering is
  declarative rather than sequenced by hand.
- **The server has no bundler in dev.** It runs as `.ts` via Node type
  stripping (Node ≥ 22.18). The published package is bundled with tsup.
- **SSE, not WebSocket.** Logs only flow towards the browser; commands are
  ordinary POSTs. No upgrade handshake, no extra dependency, and `EventSource`
  reconnects by itself.
- **Two buffers per proc, on purpose.** The chunk backlog is terminal-oriented
  (raw PTY bytes, replayed into xterm); the line buffer is machine-oriented
  (clean text, timestamps, a stable cursor). One would have to lie to the other.
- **Per-proc backlog, one stream per subscriber.** Each proc keeps its last
  256 KB of output; a subscriber (an SSE connection) gets every proc's backlog
  and status, a `synced` marker, then live events from a `PubSub` it subscribed
  to _before_ the snapshot — no gap, and a per-proc chunk counter cuts the
  duplicate at the seam. A tab opened on a deck that has run for days still
  shows every pane's history, and the UI knows exactly which chunks are news
  (unread tallies, notifications).
- **The supervisor is `Effect.acquireRelease`.** Shutdown is not a code path
  anyone has to remember to call: closing the scope terminates every process
  tree. The SSE response stream lives in the request scope, so a dropped tab
  cleans up its subscription too. Ctrl-C, `procdeck down` and the UI's ⏻ are
  all the same SIGTERM into the same scope.
- **Detached is just `up --fg` in the background.** No daemon, no IPC: `up`
  spawns itself detached with its output in a log file, and waits for the
  child's registry entry to appear — written only after `listen` succeeds — so
  "up" means reachable. The registry is plain files pruned by pid; every deck
  serves its own UI, and the deck switcher is a list of links.
- **The observer is the port assignment.** Because procdeck already hands out
  `${port}`, it can stand on the public port and give the proc a hidden one.
  That is what makes server-to-server traffic visible without asking the app
  for anything.

## Tests

```sh
pnpm test
```

Integration tests with real (tiny) processes — `node -e` one-liners and shells
with background children — because the risks live at the OS boundary: PTY
detection, group kills, SIGTERM-ignoring survivors, scope teardown. Mocking any
of that would test the mock.

They need a real PTY (`/dev/ptmx`), so they will not run inside sandboxes that
block PTY allocation.

**Gotcha.** If every spawn fails with `posix_spawnp failed.`, the usual culprit
is the node-pty `spawn-helper` prebuild arriving without its execute bit
(pnpm/Bun skipping its install script). `proc.ts` restores the bit at import
time, so this should self-heal — if it still fails, PTY allocation itself is
probably blocked.

## Conventions

- `oxlint` and `oxfmt` (no semicolons, no trailing commas) — `pnpm lint`,
  `pnpm format`.
- The Effect language service is patched into `tsc` by the root `prepare`
  script, so `pnpm check:types` reports Effect diagnostics too; severities live
  in `tsconfig.base.json`.
- User-facing prose for config fields lives in `Schema` annotations in
  `config.ts`, never in JSDoc: `schema.json` is generated from them, so JSON
  configs and editor tooltips cannot drift from the runtime validation.
