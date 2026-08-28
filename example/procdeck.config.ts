import { defineConfig } from "procdeck"

/**
 * A self-contained demo of every procdeck feature, using only Node:
 *
 * - `api` pins its `${port}` to a fixed public number (`port: 4831`) — scripts
 *   and dotenv files can hardcode `localhost:4831`, yet the traffic is still
 *   captured — and serves a small shop API with routes that succeed and fail.
 * - `worker` waits for `api` (`needs`), passes a `preflight` gate first, and
 *   buys things on a timer through `${port:api}` — server-to-server HTTP
 *   that the observer captures (every third order is broken on purpose).
 * - `chat` is a dependency-free WebSocket server; its messages are captured
 *   per-frame with direction and text.
 * - `web` serves the shop page: browser calls to `api.localhost`, a live
 *   chat widget on `chat.localhost`.
 * - `clock` never listens, so readiness is "it spawned" (`readyWhen`).
 * - `flaky` shows alerts: when its output matches a pattern, the pane gets a
 *   badge in the UI.
 *
 * Run `pnpm dev`, open http://localhost:4840 — then http://web.localhost:4840
 * (every pane is also reachable at a stable subdomain of the UI port,
 * whatever port it actually got). Click around, then watch the traffic:
 *
 *     procdeck http                # every captured exchange, interleaved
 *     procdeck http --digest       # 4xx/5xx grouped by route (worker's 422s)
 *     procdeck http --status 5xx   # the cursed product
 *     procdeck http --ws --body    # the chat messages, with text
 *     procdeck errors api          # parsed + deduplicated error output
 *
 * And the verify loop: `procdeck mark` → click a button on the web page →
 * `procdeck http --since-mark default --body`.
 */
export default defineConfig({
  // `name` is the tab title and the installed app's name; it defaults to the
  // config directory's basename ("example" here), so it is left out.
  port: 4840,
  procs: [
    {
      id: "api",
      cmd: ["node", "servers/api.mjs"],
      // The public side of `${port}` stays exactly 4831; the observer still
      // captures the traffic behind it.
      port: 4831,
      env: { PORT: "${port}" }
    },
    {
      id: "worker",
      cmd: ["node", "servers/worker.mjs"],
      env: { API_URL: "http://localhost:${port:api}" },
      needs: ["api"],
      readyWhen: "started",
      // A gate that must pass before the proc spawns; this one always does —
      // swap the pattern for something failing to see the "blocked" state.
      preflight: {
        shell: "node --version",
        expect: "v\\d+",
        hint: "install Node 22+ first"
      }
    },
    {
      id: "chat",
      cmd: ["node", "servers/chat.mjs"],
      env: { PORT: "${port}" }
    },
    {
      id: "web",
      cmd: ["node", "servers/web.mjs"],
      env: { PORT: "${port}", API_URL: "http://localhost:${port:api}" },
      needs: ["api"]
    },
    {
      id: "clock",
      shell: "while true; do date; sleep 1; done",
      readyWhen: "started"
    },
    {
      id: "flaky",
      shell: "sleep 3; echo 'ERROR: something odd happened'; sleep 600",
      readyWhen: "started",
      alerts: [{ pattern: "ERROR", label: "check me" }]
    }
  ]
})
