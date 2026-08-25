---
"procdeck": major
---

procdeck 1.0.0. Nothing breaks in this release — the version says the surface
is settled and will not move under you without a major bump.

What 1.0 promises to keep stable:

- **The config**, both formats: every field of the schema (and therefore
  `schema.json`), the `${port}` / `${port:id}` templating, `needs` /
  `readyWhen` readiness, `preflight`, `alerts`, `observe`, and the
  `defineConfig` export.
- **The CLI**: the verbs (`up`, `down`, `restart`, `status`, `ls`, `open`,
  `init`, `logs`, `mark`, `wait-for`, `errors`, `http`, `agents`, `mcp`),
  their flags, and the shape of every `--json` payload. `wait-for` keeps exit
  2 for a timeout.
- **The MCP tools**: names and parameters of `deck_status`, `get_logs`,
  `get_http`, `get_errors`, `set_mark`, `wait_for`, `timeline`, and the
  `--mutations` trio.
- **The addresses**: `<id>.localhost:<ui-port>` for every proc, the UI on
  4820 by default, loopback-only unless `host` says otherwise.

Internals stay internal: the deck's HTTP API, the registry files under
`~/.procdeck/`, the SSE event shapes and everything under `src/` are free to
change.

The readme is now the pitch and the docs live in `docs/` — config reference,
the agent harness, the traffic observer and the architecture notes.
