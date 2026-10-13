---
name: procdeck
description: This project's dev processes (servers, watchers) run under procdeck. Use when checking whether dev processes are healthy, reading their logs, diagnosing crashes or errors, restarting a process, or verifying a code change against the running dev server.
---

# procdeck — the project's dev processes

Every dev process runs under procdeck (web UI + CLI). Never start dev servers
in ad-hoc terminals — the deck already runs them. If nothing is up:
`procdeck up` (detaches; the deck outlives the terminal).

## First question

`procdeck status --json` — cheap, and its `attention` list names every
proc that deserves a look (crashed with exit code, blocked with hint,
alerting) so you skip log-reading when everything is green.

## Reading output

- `procdeck logs <proc> [--lines N] [--grep RE] [--since 5m]` — bounded
  tail (default 200 lines); `--grep` is a case-insensitive RegExp.
- `procdeck logs` (no proc) — every process interleaved, `[id]` prefixes.
- `procdeck errors [proc]` — errors parsed out of the output and
  deduplicated: "same TypeError, 41×, last 3s ago" plus one sample trace.
  Heuristic — fall back to `logs --grep` if it misses something.
- `procdeck http [proc] [--status 5xx] [--path RE] [--body]` — captured
  HTTP traffic (requests into the procs and between them): method, path,
  status, duration. `--body` adds the captured text bodies; `--digest`
  groups 4xx/5xx by route; `--ws` narrows to WebSocket messages (captured
  on the same connections, with direction and text). Traffic is seen on
  `*.localhost` addresses and assigned `${port}` ports — not on
  hardcoded ports or calls out to the internet.
- Add `--json` to any of these for machine-readable output.

## Verifying a change (the loop that matters)

1. `procdeck mark` — drop a marker at "now".
2. Act: edit code, `procdeck restart <proc>` if it does not hot-reload.
3. `procdeck wait-for <proc>` — until a listening port; or
   `--pattern "listening"` for an output line. Crashes fail fast with the
   log tail on stderr (exit 1); timeout is exit 2.
4. Exercise it (curl the endpoint, run the test).
5. `procdeck logs --since-mark default` / `procdeck errors --since-mark
   default` / `procdeck http --since-mark default` — only what your
   action caused; `http` shows the actual statuses and bodies.

## Notes

- `procdeck restart` (no proc) restarts the whole deck — config edits need
  that; a single proc is cheaper when the code changed.
- Each proc may have a stable address: `http://<id>.localhost:<ui-port>`
  (see `proxyUrl` in status output).
- MCP alternative: `claude mcp add procdeck -- procdeck mcp` exposes these
  as tools (deck_status, get_logs, get_http, get_errors, set_mark, wait_for,
  timeline) in every procdeck project at once.
