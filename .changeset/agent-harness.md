---
"procdeck": minor
---

procdeck is now a harness for coding agents, not just a dashboard for humans.
New CLI verbs, all bounded and `--json`-able: `status --json` grows an
`attention` list (crashed / blocked / alerting procs with reasons — the
cheapest first question); `logs [proc]` returns pane output as plain
timestamped lines (ANSI stripped, `\r` progress bars keep only their final
state), filterable with `--grep`, `--since`, `--lines` — no proc means every
proc interleaved with `[id]` prefixes, and the old daemon-log behaviour moved
to `logs --self [-f]`; `mark [name]` drops a named marker in every proc's
stream and `--since-mark` shows only what happened after it — the verify
loop (mark → edit → restart → check) in four commands; `wait-for <proc>
[--pattern RE]` blocks until a listening port or a matching line, failing
fast with the log tail if the proc crashes instead (exit 2 on timeout);
`errors [proc]` parses stack traces out of recent output and deduplicates
them by signature ("same TypeError, 41×, last 3s ago"); `restart <proc>`
restarts a single process. `procdeck mcp` serves the same verbs over MCP
(stdio) — `claude mcp add procdeck -- procdeck mcp` once, globally, and the
instance registry finds the right deck per project; read-only by default,
`--mutations` adds restart/stop/start, plus `since_last` cursors and a
`timeline` tool. `procdeck agents` (and `procdeck init`) plant the discovery:
a `## procdeck` section in CLAUDE.md / AGENTS.md and a Claude Code skill
teaching the loop.
