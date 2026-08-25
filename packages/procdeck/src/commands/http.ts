/**
 * `procdeck http` — the captured HTTP traffic (docs/http-observability.md):
 * what flowed through the `*.localhost` proxy and each proc's assigned port.
 * A bounded tail like `logs`, plus `--digest` — the `errors` analog for
 * traffic: 4xx/5xx grouped by route.
 */

import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { apiGet, httpParams } from "../agent/client.ts"
import { digestHttp } from "../http-log.ts"
import type { DeckCapture, HttpDigestGroup, HttpResult } from "../http-log.ts"
import {
  callApi,
  describeUptime,
  fail,
  jsonFlag,
  parseDuration,
  requireInstance
} from "./shared.ts"

const DEFAULT_LIMIT = 50
/** `--digest` wants the whole ring, not a tail — the server caps at 1000. */
const DIGEST_SCAN = 1000

const size = (bytes: number): string =>
  bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}kB`

const clock = (ts: number): string => {
  const date = new Date(ts)
  const pad = (value: number, width = 2) => String(value).padStart(width, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

const renderExchange = (exchange: DeckCapture, multi: boolean, bodies: boolean): string => {
  const who = multi ? `[${exchange.proc}] ` : ""
  if (exchange.kind === "ws") {
    // "→" flows into the proc (client → server), "←" out of it.
    const arrow = exchange.dir === "in" ? "→" : "←"
    const head = `${clock(exchange.ts)} ${who}ws${arrow} ${exchange.path} ${exchange.opcode} ${size(exchange.size)} #${exchange.connId}`
    return bodies && exchange.text !== undefined && exchange.text.length > 0
      ? `${head}\n  msg: ${exchange.text.split("\n").join(`\n  `)}`
      : head
  }
  const status = exchange.status === 0 ? "refused" : String(exchange.status)
  const head = `${clock(exchange.ts)} ${who}${exchange.method} ${exchange.path} → ${status} ${exchange.durationMs}ms ${size(exchange.resBytes)}`
  if (!bodies) return head
  const block = (label: string, body: string | undefined) =>
    body === undefined || body.length === 0 ? [] : [`  ${label}: ${body.split("\n").join(`\n  `)}`]
  return [head, ...block("req", exchange.reqBody), ...block("res", exchange.resBody)].join("\n")
}

const renderDigest = (group: HttpDigestGroup): string => {
  const status = group.status === 0 ? "refused" : String(group.status)
  const span = group.count > 1 ? ` · first ${describeUptime(group.firstTs)} ago` : ""
  return `[${group.proc}] ${group.count}× ${status} ${group.method} ${group.path} — last ${describeUptime(group.lastTs)} ago${span}`
}

export const http = Command.make(
  "http",
  {
    proc: Argument.string("proc").pipe(
      Argument.optional,
      Argument.withDescription("proc id (default: every proc, interleaved)")
    ),
    limit: Flag.integer("limit").pipe(
      Flag.withAlias("n"),
      Flag.withDefault(DEFAULT_LIMIT),
      Flag.withDescription("max exchanges — the most recent ones (default 50, max 1000)")
    ),
    status: Flag.string("status").pipe(
      Flag.optional,
      Flag.withDescription('only this status: "5xx", "422", or "error" (4xx/5xx/refused)')
    ),
    path: Flag.string("path").pipe(
      Flag.optional,
      Flag.withDescription("only paths matching this RegExp (case-insensitive)")
    ),
    since: Flag.string("since").pipe(
      Flag.optional,
      Flag.withDescription("only exchanges newer than this — 30s, 5m, 2h")
    ),
    sinceMark: Flag.string("since-mark").pipe(
      Flag.optional,
      Flag.withDescription("only exchanges after `procdeck mark <name>` was set")
    ),
    ws: Flag.boolean("ws").pipe(
      Flag.withDescription("only WebSocket messages (default: http and ws interleaved)")
    ),
    body: Flag.boolean("body").pipe(
      Flag.withDescription("include captured request/response bodies and ws message text")
    ),
    digest: Flag.boolean("digest").pipe(
      Flag.withDescription("4xx/5xx grouped by route with counts — the errors view for traffic")
    ),
    json: jsonFlag
  },
  ({ body, digest, json, limit, path, proc, since, sinceMark, status, ws }) =>
    Effect.gen(function* () {
      const instance = yield* requireInstance(Option.none())
      let sinceMs: number | undefined
      if (Option.isSome(since)) {
        const ms = parseDuration(since.value)
        if (ms === undefined) return yield* fail(`bad --since "${since.value}" — try 30s, 5m, 2h`)
        sinceMs = Date.now() - ms
      }
      const params = httpParams({
        proc: Option.getOrUndefined(proc),
        limit: digest ? DIGEST_SCAN : limit,
        status: digest ? undefined : Option.getOrUndefined(status),
        path: Option.getOrUndefined(path),
        sinceMs,
        mark: Option.getOrUndefined(sinceMark),
        kind: ws ? "ws" : undefined,
        bodies: body
      })
      const result = yield* callApi(() => apiGet<HttpResult>(instance, `/http?${params}`))

      if (digest) {
        const groups = digestHttp(result.exchanges)
        if (json) {
          return yield* Console.log(
            JSON.stringify({ digest: groups, scannedExchanges: result.exchanges.length })
          )
        }
        if (groups.length === 0) {
          return yield* Console.log(
            `procdeck: no failing requests among ${result.exchanges.length} captured exchanges`
          )
        }
        return yield* Console.log(groups.map(renderDigest).join("\n"))
      }

      if (json) return yield* Console.log(JSON.stringify(result))
      if (result.exchanges.length === 0) {
        return yield* Console.error(
          "procdeck: no captured exchanges — traffic is seen on the *.localhost addresses and on assigned ports (${port})"
        )
      }
      const multi = Option.isNone(proc)
      if (result.omitted > 0) {
        yield* Console.log(`… ${result.omitted} earlier matching exchanges omitted (raise --limit)`)
      }
      yield* Console.log(
        result.exchanges.map((exchange) => renderExchange(exchange, multi, body)).join("\n")
      )
    })
).pipe(
  Command.withDescription(
    "HTTP traffic captured between and into the deck's processes: method, path, status, duration — and WebSocket messages on the same connections (`--ws`). The business data, not just the logs. `--digest` groups 4xx/5xx by route; the mark → act → `http --since-mark` loop shows exactly which requests a change caused."
  )
)
