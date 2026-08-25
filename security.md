# Security

## Reporting a vulnerability

Please report privately, not as a public issue:

- GitHub → the **Security** tab → **Report a vulnerability** (private advisory), or
- email <kondaurov.dev@gmail.com>.

Include what you did, what happened, and the version (`procdeck --version`).
This is a one-maintainer project: expect a first reply within a few days, and
a fix released as a patch once we agree on what it is. Please give it a
reasonable window before disclosing publicly.

## Supported versions

The latest published version. Fixes land on top of `main` and ship as a new
release rather than as patches to older lines.

## What procdeck is, security-wise

It is a local development tool, and its threat model follows from one fact:
**the web UI types into real terminals.** Anyone who can reach the UI's port
can run commands as the user who started the deck, read every pane's output,
and restart or stop processes.

That is why:

- The server binds **127.0.0.1 only** by default. Setting `"host": "0.0.0.0"`
  in the config exposes a remote shell to everyone who can route to that port —
  use it only on a network you trust (a devcontainer's host, a VM), never on a
  shared or public one. procdeck has no authentication, by design: adding a
  login would imply it is safe to expose, and it is not.
- The `*.localhost` reverse proxy is reachable on that same port, and so are
  the deck's HTTP API and the captured traffic.
- `procdeck mcp` is **read-only by default**; `--mutations` is what adds
  restart/stop/start for an agent.

## The traffic observer

`procdeck http` captures requests flowing through the `*.localhost` proxy and
through each proc's assigned `${port}`. What that means for secrets:

- Captures live **in memory only** — a bounded ring per proc, ~512 kB, gone
  when the deck stops. Nothing is written to disk.
- `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`
  and `x-auth-token` are replaced with `[redacted]` **at capture time**, so
  their values never enter the ring.
- Request and response **bodies are captured** when the content type is text,
  up to 16 kB each. If your dev traffic carries tokens or personal data in
  bodies, that data is readable by anything that can reach the deck — including
  a coding agent you gave the MCP tools to. Set `"observe": false` on a proc to
  turn its capture off.

## Other notes

- No telemetry, no phoning home, no service worker.
- procdeck spawns whatever your config says, with your environment. A config
  file is executable content: treat `procdeck.config.ts` from an untrusted
  repository exactly like you would treat its `package.json` scripts.
- The deck registry under `~/.procdeck/` holds one JSON per running deck (pid,
  port, paths) and detached decks' log files. Anything readable in a pane is
  readable there.
