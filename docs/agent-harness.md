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

## Order of work: JSON CLI first, MCP as a layer on top

Agents are fluent in bash. A CLI answers 80% of the need with zero setup,
works with _any_ agent (not just MCP clients), and becomes the thin
implementation layer for the MCP tools later. So:

**Phase 1 — CLI (read-only core) — shipped.** Extends the
`effect/unstable/cli` command tree; everything talks to the running deck's
HTTP API (`GET /logs`, `POST /marks`) via the instance registry. The shared
prerequisite landed with it: per-proc **line** buffers (`src/lines.ts`,
256 KB each, ANSI stripped, `\r` progress bars keep only their final state,
per-proc `seq` as a stable cursor) — the same buffers the merged view and
grep mode in plan.md want.

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
  `src/errors.ts` — the MCP layer will reuse it as-is.

**Phase 2 — MCP server — shipped.** `procdeck mcp` (stdio, `src/mcp.ts` on
effect's `McpServer`): the user runs `claude mcp add procdeck -- procdeck
mcp` once, globally, and it works in every project — the deck is resolved
_per tool call_ via cwd → config-walk → registry, so the server outlives
deck restarts and can start before the deck is up. The registry pays for
itself a second time here. Tools mirror the CLI verbs 1:1: `deck_status`,
`get_logs` (grep/since/mark — `search_logs` folded into it), `get_errors`,
`set_mark`, `wait_for`. Tool descriptions carry the workflow ("call
deck_status first", the mark → act → since_mark loop) — the "skill text"
lives in the tools themselves. Problems come back as `{error}` _values_,
not protocol errors, so the agent can read "deck is down — run `procdeck
up`" and act on it. Bundle cost: +0.3 MB.

The two conveniences on top — shipped as well:

- **Per-client cursors** (`get_logs {since_last: true}`) — "only what arrived
  after my previous get_logs call". One stdio process is one MCP session, so
  the cursor is plain state in the server process; every get_logs response
  advances it. Under the hood: `GET /logs` accepts `sinceSeq` as a
  `{proc: seq}` JSON record now (the bare-integer single-proc form stays).
- **`timeline {at_ms?, window_seconds?, procs?}`** — interleaved lines
  within ±window around a moment: "the frontend threw a 500 at T — what
  were api and worker doing?". `at_ms` shares the clock with every line's
  `ts` and get_errors' timestamps, so the agent can pivot from an error
  straight into its moment. Under the hood: `untilMs` on `GET /logs`,
  paired with `sinceMs`.

What MCP adds over the CLI: discoverability (the agent sees the tools and
their descriptions without being told) and typed arguments. What it does not
add: any capability — every tool is a CLI verb over the same `src/client.ts`
deck API client.

**Mutating tools** — shipped as designed: `restart_proc` / `stop_proc` /
`start_proc` exist only behind `procdeck mcp --mutations`; read-only by
default. The server binds loopback only, unchanged.

## Discovery: how the agent learns procdeck exists

The real CLI-vs-MCP tradeoff is not implementation effort but discovery. MCP
tools are self-describing — they appear in the agent's tool list with their
descriptions, no instructions needed (the user still runs `claude mcp add`
once). A plain CLI is invisible until something tells the agent it exists;
after that agents handle a well-`--help`ed CLI fine. Escalation path:

1. **A section in the project's CLAUDE.md / AGENTS.md** (shipped) — "dev
   processes run under procdeck; `status --json` first; never start dev
   servers in ad-hoc terminals". `procdeck init` appends it automatically
   when the project already has such a file; `procdeck agents` does it for
   existing projects (creating CLAUDE.md if neither exists). Idempotent —
   the `## procdeck` heading is the marker (`src/agents.ts`).
2. **A skill** (shipped) — `procdeck agents` also writes
   `.claude/skills/procdeck/SKILL.md` teaching the whole verify loop
   (mark → restart → wait-for → since-mark) and when to trigger. An
   existing skill file is never overwritten.
3. **MCP** (shipped) — discovery built into the tools themselves.

Shipped alongside, because the verify loop exposed the gap: `procdeck
restart <proc>` restarts a single process via the deck's API (bare
`restart` still bounces the whole deck — config edits need that).

The "explain the workflow to the agent" text exists in all three — it just
lives in CLAUDE.md, a skill, or MCP tool descriptions respectively. MCP does
not remove that work; it removes the need to distribute it per project.

## Cheap adjacent wins (no MCP required)

- **"Copy context for agent" button in the web UI** — one block: recent log
  excerpt + proc status + restart history + last exit, ready to paste into a
  chat. Zero infrastructure, immediate value, and a good forcing function
  for deciding what a useful "context bundle" contains before encoding the
  same shape into `errors`/`get_logs`.
- **Attention-first convention** — document (README, MCP tool descriptions)
  that the intended first call is `status`: it is the cheapest and answers
  "is anything broken?" before any log reading.

## Dependencies and open questions

- ~~Per-proc **line** buffers on the server~~ — shipped with Phase 1
  (`src/lines.ts`); the merged view and grep mode in plan.md can now build
  on them.
- ~~Stack-trace parsing for `errors`~~ — shipped as planned: dumb heuristics
  (`src/errors.ts`), not language completeness; `logs --grep` is the
  fallback.
- ~~Marker storage~~ — shipped: in-memory per deck, named, capped at 100.
- `--json` shape: stable, versioned-by-addition only; agents will be written
  against it.
- `logs --follow` for pane output (only `--self` follows today) — an SSE
  consumer in the CLI; useful for humans, less so for agents (bounded pulls
  beat an open stream in a tool-call world).
- ~~**HTTP observability**~~ — shipped: `procdeck http` / the `get_http` MCP
  tool capture the traffic between the procs and into them (statuses,
  bodies — the business data), via a tap on the `*.localhost` proxy and an
  observer interposed on each assigned port. Marks span both streams, so the
  verify loop now has its second half. Plan, decisions and the remaining
  phases (WebSocket frames, UI network tab) in docs/http-observability.md.
