# Traffic

Dev apps are mostly HTTP apps. Logs tell you a process is alive; the _business
data_ flows as requests between processes, and stays invisible unless someone
printed it. procdeck is already standing in that stream, so it captures it:

```sh
procdeck http                       # every proc, newest last
procdeck http api --status error    # only 4xx / 5xx / refused
procdeck http --digest              # failures grouped by route, with counts
procdeck http api --body -n 5       # with request/response bodies
```

```
14:02:11.883 [web] GET /checkout → 200 34ms 12.4kB
14:02:11.902 [api] POST /orders → 422 8ms 231B
14:02:12.140 [chat] ws→ /socket text 84B #3
```

## How it sees the traffic

Two interception points, both free of any change to your app:

1. **The `*.localhost` reverse proxy.** Everything a browser sends to
   `api.localhost:4820` already flows through procdeck.
2. **Assigned ports** — the interesting one. A proc that uses `${port}` binds a
   hidden internal port; procdeck listens on the _public_ assigned port and
   forwards. `${port:api}` resolves to the public one, so server-to-server
   calls (web → api, api → worker) pass through the observer too. This is the
   half a browser's DevTools can never show you.

Set `"observe": false` on a proc to hand it the public port directly — no
interposition, no capture, and the proxy tap still sees browser traffic.

## What is captured

Per exchange: timestamp, method, path, status, duration, request and response
byte sizes. WebSocket messages land in the same ring with a direction, a size
and a `connId` tying them to their status-101 upgrade.

Bodies are teed as they stream past, but only when the content type says text
— at most 16 kB each, with the full size always reported separately. Binary
bodies are a fact and a size, never bytes. `--body` is what decides whether the
stored bodies are _shown_. Sensitive headers (`authorization`, `cookie`,
`set-cookie`, `x-api-key` and friends) are replaced with `[redacted]` at
capture time, so they never reach the ring at all.

Each proc keeps the last 512 kB of captures, evicting oldest-first. Nothing is
written to disk and nothing survives the deck.

## Narrowing

| Flag                           | What                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `-n, --limit <n>`              | Most recent N exchanges (default 50, max 1000).                                  |
| `--status 5xx \| 422 \| error` | One class, one code, or everything that failed (4xx/5xx/refused).                |
| `--path <regexp>`              | Case-insensitive match on the path.                                              |
| `--ws`                         | Only WebSocket messages (default: http and ws interleaved).                      |
| `--since 30s \| 5m \| 2h`      | Only what is newer than that.                                                    |
| `--since-mark <name>`          | Only what arrived after `procdeck mark <name>`.                                  |
| `--body`                       | Include captured bodies and ws message text.                                     |
| `--digest`                     | 4xx/5xx grouped by normalized route with counts — the `errors` view for traffic. |
| `--json`                       | The same answer as structured JSON.                                              |

The loop that makes this precise rather than noisy:

```sh
procdeck mark checkout
# … click through the checkout in the browser …
procdeck http --since-mark checkout --body
```

That is exactly the requests your action caused, and what they returned.

## In the UI

⇄ in the bar is a third layout next to single and grid: the same captures as a
live list, filterable by proc, by kind (all / http / ws) and down to failures
only, with bodies expandable per row. A network tab for your processes rather
than for a browser tab.

## Blind spots

- **Outbound calls to the internet.** procdeck stands between your processes,
  not between them and the world.
- **Procs on hardcoded ports.** Capture follows `${port}`; a proc that binds
  `3000` by itself is only seen through the `*.localhost` proxy, and only for
  traffic that actually goes there.
- **HTTPS upstreams.** Local dev is plain HTTP; procdeck does not terminate TLS.
- **Binary bodies** are counted and sized, never stored.

Agents read the same captures through `procdeck http --json` or the `get_http`
MCP tool — see [agents.md](agents.md). The design notes are in
[design/http-observability.md](design/http-observability.md).
