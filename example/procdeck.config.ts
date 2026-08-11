import { defineConfig } from "procdeck"

/**
 * A self-contained demo of every procdeck feature, using only Node:
 *
 * - `api` gets a free port assigned by procdeck (`${port}` — arrives as $PORT).
 * - `web` waits for `api` (`needs`), gets its own assigned port, and finds the
 *   api through `${port:api}` — no port numbers anywhere in the stack.
 * - `clock` never listens, so readiness is "it spawned" (`readyWhen`).
 * - `flaky` shows alerts: when its output matches a pattern, the pane gets a
 *   badge in the UI.
 *
 * Run `pnpm dev`, open http://localhost:4820 — then http://web.localhost:4820
 * and http://api.localhost:4820: every pane is also reachable at a stable
 * subdomain of the UI port, whatever port it actually got.
 */
export default defineConfig({
  port: 4820,
  procs: [
    {
      id: "api",
      cmd: ["node", "servers/api.mjs"],
      env: { PORT: "${port}" },
    },
    {
      id: "web",
      cmd: ["node", "servers/web.mjs"],
      env: { PORT: "${port}", API_URL: "http://localhost:${port:api}" },
      needs: ["api"],
    },
    {
      id: "clock",
      shell: "while true; do date; sleep 1; done",
      readyWhen: "started",
    },
    {
      id: "flaky",
      shell: "sleep 3; echo 'ERROR: something odd happened'; sleep 600",
      readyWhen: "started",
      alerts: [{ pattern: "ERROR", label: "check me" }],
    },
  ],
})
