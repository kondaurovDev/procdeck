---
"procdeck": minor
---

procdeck sees the traffic now, not just the logs. Procs that use `${port}`
get an HTTP observer interposed on their assigned port: the proc binds a
hidden internal port, procdeck listens on the public one and forwards — so
requests between processes (`${port:api}`) and into them are captured
transparently, statuses and bodies included, with zero app changes
(`"observe": false` opts a proc out; the `*.localhost` proxy captures for
opted-out procs). WebSocket connections are captured per-message with
direction and text — compression is stripped at the handshake so frames stay
readable. Bodies are text-only and truncated (16 KB); `authorization`,
`cookie` and friends are redacted before anything is stored. Three surfaces
over the same per-proc rings: `procdeck http [proc] [--status 5xx|422|error]
[--path RE] [--since-mark] [--ws] [--body] [--digest] [--json]` — `--digest`
groups 4xx/5xx by route with path params collapsed (`/users/:id`); a
`get_http` MCP tool with `since_last` cursors (and `timeline` now carries
the window's exchanges); and a traffic view in the UI — the ⇄ position of
the layout switch — with kind/proc/errors filters, click-to-expand bodies,
pause and clear. Marks span both streams, so mark → act →
`http --since-mark` shows exactly which requests a change caused and what
they returned.
