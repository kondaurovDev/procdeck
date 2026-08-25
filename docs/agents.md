# procdeck for coding agents

A coding agent edits code, but the consequences land in processes it did not
start and cannot see. Without a harness it either spawns its own copy of the
dev server — duplicate processes, port fights — or asks you to paste logs.

procdeck already owns those processes: their output, their ports, their
restart lifecycle, the traffic between them. Every one of those is available
as a bounded, machine-readable command. The same verbs are served over MCP,
so an agent that speaks MCP needs no shell at all.

## The verify loop

The point is not "ask about logs". It is closing the agent's edit → verify
cycle, in four commands:

```sh
procdeck mark before-fix              # drop a marker at "now"
# … the agent edits code …
procdeck restart api                  # restart just that process
procdeck wait-for api                 # block until it listens again (exit 2 on timeout)
procdeck logs --since-mark before-fix # only the output the change caused
procdeck http --since-mark before-fix # and only the requests it caused
```

`--since-mark` is what makes the answer small: not "the last 200 lines", but
"what happened because of what I just did".

## Setup

```sh
procdeck agents
```

Writes a `## procdeck` section into `CLAUDE.md` / `AGENTS.md` (creating the
file if absent) and installs a Claude Code skill that teaches the loop above.
Idempotent — run it again after an update. `procdeck init` does the same for a
fresh project.

For MCP, one global registration covers every project:

```sh
claude mcp add procdeck -- procdeck mcp
```

The instance registry finds the right deck for whatever project the agent is
working in, so there is nothing per-project to configure.

## Commands

Every one of these takes `--json` and is bounded by default — an agent cannot
accidentally pull a megabyte of scrollback into its context.

| Command                    | Answers                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `procdeck status --json`   | Every proc's state, ports and restarts, plus an `attention` list naming crashed / blocked / alerting procs with reasons. The cheapest first question.               |
| `procdeck logs [proc]`     | Pane output as plain timestamped lines: ANSI stripped, `\r` progress bars reduced to their final state. No proc means every proc, interleaved with `[id]` prefixes. |
| `procdeck errors [proc]`   | Stack traces parsed out of recent output and deduplicated by signature: "same TypeError, 41×, last 3s ago" with one sample.                                         |
| `procdeck http [proc]`     | The captured HTTP and WebSocket traffic — see [traffic.md](traffic.md).                                                                                             |
| `procdeck mark [name]`     | Drops a named marker at "now" in every proc's stream.                                                                                                               |
| `procdeck wait-for <proc>` | Blocks until the proc listens (or `--pattern` matches). Fails fast with the log tail if it crashes instead; exit 2 on timeout.                                      |
| `procdeck restart <proc>`  | Restarts one process. Without an id, the whole deck.                                                                                                                |

Narrowing flags, shared by `logs`, `errors` and `http`:

| Flag                      | What                                                 |
| ------------------------- | ---------------------------------------------------- |
| `--since 30s \| 5m \| 2h` | Only what is newer than that.                        |
| `--since-mark <name>`     | Only what arrived after that mark was set.           |
| `--grep <regexp>`         | `logs` only: case-insensitive match on the line.     |
| `-n, --lines <n>`         | `logs` / `errors`: max lines, default 200, max 5000. |
| `--json`                  | The same answer as structured JSON.                  |

`procdeck logs --self [-f]` is a different thing: procdeck's own daemon log
(startup, shutdown, its own errors), not pane output.

## MCP

`procdeck mcp` serves the same verbs over stdio. Read-only by default:

| Tool          | Notes                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deck_status` | The `attention` list first; call it before reading logs.                                                                                               |
| `get_logs`    | `proc`, `lines`, `grep`, `since_seconds`, `since_mark`, `since_last`.                                                                                  |
| `get_http`    | `status`, `path`, `kind` (`http` / `ws`), `bodies`, plus the same cursors.                                                                             |
| `get_errors`  | Deduplicated stack traces.                                                                                                                             |
| `set_mark`    | The marker half of the verify loop.                                                                                                                    |
| `wait_for`    | `proc`, `pattern`, `timeout_seconds`.                                                                                                                  |
| `timeline`    | Output of several procs _and_ the HTTP exchanges around a moment in time: "the frontend threw a 500 at T — what were api and worker doing right then?" |

`since_last: true` returns only what arrived after that tool's previous call in
the same session — a cursor the agent does not have to maintain.

`procdeck mcp --mutations` additionally exposes `restart_proc`, `stop_proc` and
`start_proc`. That is opt-in on purpose: read-only is the safe default for a
tool registered globally across every project.

## What it does not see

- Outbound calls to the internet, and traffic of procs that bind a hardcoded
  port instead of `${port}` — see the blind spots in [traffic.md](traffic.md).
- Anything the process never wrote to stdout/stderr and never sent over HTTP.

Marks live in memory and die with the deck; re-marking the same name moves it.

The design notes behind all of this are in
[design/agent-harness.md](design/agent-harness.md).
