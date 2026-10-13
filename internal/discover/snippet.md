## procdeck

Dev processes (servers, watchers) run under procdeck — a process manager with
a web UI, CLI and MCP server. Never start dev servers in ad-hoc terminals:
the deck already runs them (`procdeck up` brings it back if it is down).

- `procdeck status --json` — ask this first: the `attention` list names
  crashed / blocked / alerting procs with reasons.
- `procdeck logs [proc] [--grep RE] [--since 5m] [--lines N]` — recent
  output; without `proc` every process interleaved with `[id]` prefixes.
- `procdeck errors [proc]` — recent errors, parsed and deduplicated.
- `procdeck http [proc] [--status 5xx] [--path RE] [--body]` — captured
  HTTP traffic between and into the procs (method, path, status, duration);
  `--digest` groups 4xx/5xx by route.
- Verify a change: `procdeck mark` → act (edit, `procdeck restart <proc>`,
  hit the endpoint) → `procdeck logs --since-mark default` / `procdeck http
  --since-mark default` show only what your action caused.
- `procdeck wait-for <proc> [--pattern RE]` — block until ready after a
  restart; exits 1 fast if it crashed (with the log tail), 2 on timeout.
