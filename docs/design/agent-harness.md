# Agent harness

procdeck as the runtime harness for agent-driven development. Coding agents
(Claude Code and friends) edit code, but the consequences land in processes
they did not start and cannot see: the dev server procdeck supervises. Today
the agent either spawns its own copy of the server (duplicates, port fights)
or asks the human to paste logs. procdeck already owns the processes, the
logs, the restart lifecycle and the attention state — it is the natural pair
of eyes on the runtime for a machine, the same way the web UI is for a human.

## The core shift: not "ask about logs" but close the verify loop

Q&A over logs is useful, but the high-value scenario is the agent's
edit-verify cycle:

1. `mark` — drop a marker "now" (the backlog already has `seq`-numbered
   chunks and a `synced` marker; this is the same semantics, client-owned).
2. Agent edits code, `restart api`.
3. `wait-for api --pattern "listening on"` (or port up) — block until ready.
4. Agent exercises the endpoint (curl, test, whatever).
5. `logs --since-mark` — only the output _caused by the agent's action_.

That turns procdeck from a log viewer into a test bench for agents. Plain
"tail over MCP" is a commodity; markers + wait-for + error dedup is the
differentiation.

## Order of work: JSON CLI first, MCP as a layer on top — then CLI only

Agents are fluent in bash. A CLI answers 80% of the need with zero setup,
works with _any_ agent (not just MCP clients), and became the thin
implementation layer for the MCP tools. The MCP layer was later removed —
see the decision below. So:

**Phase 1 — CLI (read-only core) — shipped.** Extends the
`effect/unstable/cli` command tree; everything talks to the running deck's
HTTP API (`GET /logs`, `POST /marks`) via the instance registry. The shared
prerequisite landed with it: per-proc **line** buffers (`internal/lines`,
256 KB each, ANSI stripped, `\r` progress bars keep only their final state,
per-proc `seq` as a stable cursor) — the same buffers the merged view and
grep mode in docs/plan.md want.

- `procdeck status --json` (shipped) — deck + procs + an `attention` list
  (crashed / blocked / alerting, with reasons). `{"up": false}` + exit 1
  when nothing runs. The agent's first, cheapest question.
- `procdeck logs [proc] [--lines N] [--since 2m] [--grep RE] [--since-mark
NAME] [--json]` (shipped) — tail-oriented (default 200 lines, max 5000),
  reports what was dropped ("… N earlier matching lines omitted"). _No proc
  = every proc interleaved_ with `[id]` prefixes — the old "procdeck's own
  daemon log" behaviour moved to `logs --self` (with `-f`), since pane
  output is what callers want 99% of the time.
- `procdeck mark [name]` (shipped) — named (proc → seq) snapshots,
  server-side, in-memory (they die with the deck, re-marking is free),
  capped at 100.
- `procdeck wait-for <proc> [--pattern RE] [--timeout 30s]` (shipped) —
  default waits for a listening port; `--pattern` matches new output,
  starting at the current _run's_ first line so `restart` + `wait-for`
  cannot lose a line that lands between the two commands. Fails fast on
  crash/blocked (exit 1, last lines on stderr), exit 2 on timeout.
- `procdeck errors [proc] [--since-mark] [--json]` (shipped) — heuristic
  extraction (JS/Python/Go-ish starts + frame continuations), deduped by a
  normalized signature (numbers/hex/ports collapsed): "same TypeError, 41×,
  last 3 s ago" instead of 41 stack traces. Parsing is a pure function in
  `internal/errscan`.

**Phase 2 — MCP server — shipped, then removed.** `procdeck mcp` served the
CLI verbs 1:1 as tools over stdio (`deck_status`, `get_logs`, `get_http`,
`get_errors`, `set_mark`, `wait_for`, `timeline`; `restart_proc` /
`stop_proc` / `start_proc` behind `--mutations`), resolving the deck per
call via cwd → config-walk → registry so one global `claude mcp add` covered
every project. Two conveniences lived only there: a per-session
`since_last` cursor, and `timeline` (lines and exchanges around a moment —
its server side, `untilMs` paired with `sinceMs` on `GET /logs` and
`GET /http`, stays).

**Decision: CLI only.** The MCP layer never added a capability — every tool
was a CLI verb over the same `internal/deckclient` — and what it did add
turned out not to pay for itself:

- _Discoverability_ is solved by `procdeck agents` (the CLAUDE.md section
  and the skill); an agent told once about a `--help`ed CLI uses it fine.
- _No shell needed_ matters for hosts without one; procdeck's users run
  coding agents in terminals and editors, where a shell is a given.
- _Cost_ was real: tool descriptions in the agent's context on every turn,
  deck or no deck; a Go dependency; a second surface to keep in step with
  every verb (`contributing.md` used to say "three surfaces"); an e2e suite
  and a docs page.

`since_last` has its CLI equivalent in `mark` + `--since-mark`; `timeline`
is `logs --since/--until` territory if it is ever missed. If a host without
a shell shows up, the thin layer is a day's work to bring back on the
`deckclient` package — that is the reason it was cheap to remove.

## Discovery: how the agent learns procdeck exists

The real tradeoff was never implementation effort but discovery. A plain CLI
is invisible until something tells the agent it exists; after that agents
handle a well-`--help`ed CLI fine. The ladder:

1. **A section in the project's CLAUDE.md / AGENTS.md** (shipped) — "dev
   processes run under procdeck; `status --json` first; never start dev
   servers in ad-hoc terminals". `procdeck init` appends it automatically
   when the project already has such a file; `procdeck agents` does it for
   existing projects (creating CLAUDE.md if neither exists). Idempotent —
   the `## procdeck` heading is the marker (`internal/discover`).
2. **A skill** (shipped) — `procdeck agents` also writes
   `.claude/skills/procdeck/SKILL.md` teaching the whole verify loop
   (mark → restart → wait-for → since-mark) and when to trigger. An
   existing skill file is never overwritten.
3. ~~**MCP**~~ — discovery built into the tools themselves. Shipped, then
   removed (decision above): the first two rungs carried the weight.

Shipped alongside, because the verify loop exposed the gap: `procdeck
restart <proc>` restarts a single process via the deck's API (bare
`restart` still bounces the whole deck — config edits need that).

The "explain the workflow to the agent" text is the same either way — it
lives in CLAUDE.md and the skill, distributed per project by `procdeck
agents` (idempotent, so an update is one command).

## Cheap adjacent wins

- **"Copy context for agent" button in the web UI** — one block: recent log
  excerpt + proc status + restart history + last exit, ready to paste into a
  chat. Zero infrastructure, immediate value, and a good forcing function
  for deciding what a useful "context bundle" contains before encoding the
  same shape into `errors`/`get_logs`.
- **Attention-first convention** — document (README, skill) that the
  intended first call is `status`: it is the cheapest and answers
  "is anything broken?" before any log reading.

## Dependencies and open questions

- ~~Per-proc **line** buffers on the server~~ — shipped with Phase 1
  (`internal/lines`); the merged view and grep mode in docs/plan.md can now
  build on them.
- ~~Stack-trace parsing for `errors`~~ — shipped as planned: dumb heuristics
  (`internal/errscan`), not language completeness; `logs --grep` is the
  fallback.
- ~~Marker storage~~ — shipped: in-memory per deck, named, capped at 100.
- `--json` shape: stable, versioned-by-addition only; agents will be written
  against it.
- `logs --follow` for pane output (only `--self` follows today) — an SSE
  consumer in the CLI; useful for humans, less so for agents (bounded pulls
  beat an open stream in a tool-call world).
- ~~**HTTP observability**~~ — shipped: `procdeck http` captures the
  traffic between the procs and into them (statuses,
  bodies — the business data), via a tap on the `*.localhost` proxy and an
  observer interposed on each assigned port. Marks span both streams, so the
  verify loop now has its second half. Plan, decisions and the remaining
  phases (WebSocket frames, UI network tab) in docs/design/http-observability.md.
