# Effect Discord — #share-your-work post

Draft of the procdeck announcement for the Effect Discord. Attach
`docs/screenshot.webp` and `docs/screenshot-http.webp` to the message.

---

**procdeck — a dev-process manager built end to end on Effect 4 beta, with a foldkit UI**

I'm a fullstack dev and I got tired of darting around: five terminals,
hardcoded ports, and the HTTP between my own services invisible in any
DevTools. So I built procdeck — one command runs the whole dev stack, and
everything it knows is one CLI call away:

- every proc is a real terminal in a browser tab (xterm.js over PTY), my own
  terminal stays free
- `${port}` in the config means "a free port, wired to whoever needs it", and
  every service gets an `api.localhost` address
- the HTTP/WebSocket traffic _between_ services is captured —
  `procdeck http --digest`
- everything is queryable from the CLI (`logs --since-mark fix`,
  `status --json`) — for me, or for a coding agent over MCP

The fun part for this server: it's Effect everywhere, on the 4.0 beta:

- the whole CLI is `effect/unstable/cli`; the server is an `unstable/http`
  router — SSE downstream, plus a Host-routed reverse proxy with WebSocket
  pass-through
- the supervisor is a scoped Layer: `PubSub.sliding` fan-out, per-proc fibers,
  `Latch` for readiness
- config is an Effect `Schema`, and the JSON Schema that
  `procdeck.config.json` points at is generated from it with
  `Schema.toJsonSchemaDocument` — the two formats can never disagree, and
  `description` annotations become editor tooltips
- the MCP server is `McpServer` from `effect/unstable/ai` — one `Toolkit`
  serves both the CLI verbs and the MCP tools
- the UI is [foldkit](https://foldkit.dev): one Model (a Schema), a pure
  `update`, effects as Commands; xterm terminals live as imperative islands
  via `Mount.defineStream`

Same language and the same mental model on both sides of the wire is what
made this feasible to build solo — and honestly just fast. ~2 MB installed,
one runtime dependency (the PTY bindings).

GitHub: <https://github.com/kondaurovDev/procdeck> · try it:
`npx procdeck init && npx procdeck`

Happy to answer anything about shipping a tool on the Effect 4 beta.
