# HTTP observability

Dev apps are mostly HTTP apps. procdeck supervises the processes and shows
their logs — but the *business data* flows as requests and responses between
them, and today that is invisible unless someone printed it. The goal: see
the traffic itself — "POST /orders returned 422 with this body" — for the
agent (via the harness verbs) and for the human (a network view per pane).
Companion to docs/agent-harness.md; reuses its machinery (byte-bounded ring
buffers, marks, the CLI/MCP twin surfaces).

## Why not CDP (Chrome DevTools Protocol)

CDP only sees the *browser's half* of the traffic: fetch/XHR from the page.
It misses server-to-server entirely (api → worker, backend → anything), needs
a Chrome running with a debug port, and hands the agent what the human
already has in DevTools. Not a foundation — at most a later add-on for
watching what the page does with *third-party* domains.

## The insight: procdeck is already standing in the stream

Two interception points exist, one live and one latent:

1. **The `*.localhost` reverse proxy** (live). Every request to
   `<id>.localhost:<ui-port>` already flows through `proxyRequest` /
   `proxyUpgrade` in src/server.ts. Tapping it is nearly free and covers
   browser → service traffic for anyone using the stable pane addresses.
2. **Assigned ports** (latent, the differentiator). procdeck already hands
   out `${port}` and procs address each other via `${port:api}`. So procdeck
   can *interpose*: give the proc a hidden internal port, listen on the
   public assigned port itself, and forward — a transparent per-proc proxy
   with zero app changes. That exposes **all** traffic that flows through
   assigned ports, including server-to-server — the part CDP can never see.
   Locally it is plain HTTP (no TLS problem) and the extra hop is noise;
   WebSocket pass-through code already exists in the UI proxy.

## What to capture

One ring per proc, same discipline as the line buffers (byte-bounded,
seq-cursored, marks apply):

    { proc, ts, seq, method, path, status, durationMs,
      reqBody?, resBody?,      // truncated (~16 KB), text content-types only
      reqHeaders?, resHeaders? // auth/cookie/set-cookie REDACTED by default
    }

- Binary and streaming bodies: record the fact and the size, not the bytes.
- gRPC: opaque; do not parse.
- Redaction is on by default (`authorization`, `cookie`, `set-cookie`,
  obvious token headers); a flag can widen capture for local debugging.

### WebSocket messages — same rings, per-frame capture

WebSockets carry business data too (chats, live updates, socket.io,
GraphQL subscriptions) and they pass through the same two interception
points — `proxyUpgrade` already pipes the upgraded sockets today. After the
101 the stream is framed (RFC 6455); a small parser (header, opcode,
client→server unmasking, reassemble continuation frames until FIN) turns it
into messages in the same per-proc ring:

    { proc, ts, seq, connId, dir: "in" | "out",
      text?,                   // opcode 1, truncated like HTTP bodies
      size }                   // always; binary frames record size only

- The upgrade itself is logged as a normal HTTP exchange (status 101) that
  opens `connId`; close/ping/pong are facts on the connection, not messages.
- **permessage-deflate**: libraries negotiate frame compression, which would
  make payloads unreadable. The proxy strips `Sec-WebSocket-Extensions`
  from the handshake so both sides speak uncompressed — free on loopback,
  and every text frame stays plain text. (Opt-out with the same
  `observe: false` if an app insists on the extension.)
- socket.io / engine.io framing (`42["event",...]`) is still text —
  captured raw; recognizing it is a later nicety.

**Marks make it the verify loop's second half.** `mark` → act →
"which requests happened and what did they return" is stronger evidence
than log lines: the actual status and body caused by the change.

## Surfaces

- **CLI**: `procdeck http [proc] [--since-mark NAME] [--status 5xx|422]
  [--path RE] [--body] [--json]` — bounded tail like `logs`, bodies only on
  request (token economy).
- **Digest**: `procdeck http --digest` (or a separate verb) — 4xx/5xx
  grouped by route with counts, the `errors` analog for traffic.
- **MCP**: `get_http` mirroring the CLI verb 1:1 (+ `since_last` cursors and
  `timeline` gaining http events, so the agent can pivot error → moment →
  requests around it).
- **UI**: a network tab per pane, devtools-lite — later; the agent surfaces
  come first.

## What this deliberately does not see

- **Outbound calls to the outside world** (Stripe, OpenAI, …) — they do not
  pass through our ports. Closable later with per-language instrumentation
  (Node: undici `diagnostics_channel` via NODE_OPTIONS) or an opt-in
  mitm-style proxy — different invasiveness, different plan.
- **Traffic on hardcoded ports** (a proc that ignores `${port}` and binds
  3000 itself). Port detection already knows who listens where, so the UI
  and `http` output can at least say "this port is not observed".
- gRPC and binary WebSocket payloads — facts and sizes, not contents.

## Order of work

1. **Tap the existing `*.localhost` proxy** — cheapest, code path exists,
   covers browser → service. Ring buffer + `GET /http` on the deck API.
2. **Assigned-port interposition** — the transparent per-proc proxy that
   reveals server-to-server. Opt-out per proc in the config if it ever
   bites (`observe: false`).
3. **Agent surfaces** — `procdeck http` + `get_http` MCP tool, marks and
   `since_last` wired through, redaction on, digest view.
4. **WebSocket frame capture** — the RFC 6455 parser on both interception
   points, deflate stripped at the handshake; ws messages join the same
   rings and surfaces (`--ws` filter or a `kind` field).
5. **UI network tab**; CDP add-on and outbound instrumentation — much
   later, when the itch is real.

## Open questions

- Body capture limits: 16 KB per body? per exchange? Measure against real
  dev payloads before hardcoding.
- Should the interposed proxy also serve as the readiness signal (a proc
  answering on its internal port is "ready" — sharper than "port open")?
- Digest grouping: by exact path is too fine (`/users/42`), by first
  segment too coarse — likely normalize path params (`/users/:id`) with a
  dumb heuristic (numeric/uuid segments collapsed), same spirit as error
  signatures.
- Does the UI proxy's Host-rewrite logic need the same treatment in the
  interposed proxy (vite host allowlists)? Probably yes — reuse
  `upstreamOptions`.
- WS volume: a chatty socket (HMR, presence pings) can flood the ring —
  same-byte-budget answer probably suffices, but maybe skip known-noise
  connections (vite HMR) by default.
- Is stripping permessage-deflate ever observable to the app beyond
  bandwidth? (It should not be — the extension is negotiated, not assumed —
  but verify against ws and socket.io.)
