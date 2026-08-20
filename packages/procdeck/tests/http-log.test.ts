import { describe, expect, test } from "vitest"
import {
  BODY_LIMIT,
  BodyTap,
  digestHttp,
  HttpBuffer,
  isTextType,
  normalizePath,
  queryHttp,
  redactHeaders,
  statusMatcher,
} from "../src/http-log.ts"
import type { DeckCapture, HttpCapture, HttpExchange } from "../src/http-log.ts"

/** Most assertions look at http entries; make the union access explicit. */
const asHttp = (capture: DeckCapture | undefined): HttpExchange => {
  expect(capture).toBeDefined()
  expect(capture!.kind).not.toBe("ws")
  return capture as HttpExchange
}

const capture = (over: Partial<HttpCapture>): HttpCapture => ({
  ts: 0,
  method: "GET",
  path: "/",
  status: 200,
  durationMs: 1,
  reqBytes: 0,
  resBytes: 0,
  ...over,
})

describe("BodyTap", () => {
  test("keeps text bodies, counts every byte", () => {
    const tap = new BodyTap(true)
    tap.push("hello ")
    tap.push(Buffer.from("world"))
    expect(tap.body).toBe("hello world")
    expect(tap.bytes).toBe(11)
  })

  test("binary bodies are a size, not bytes", () => {
    const tap = new BodyTap(false)
    tap.push(Buffer.alloc(1000))
    expect(tap.body).toBeUndefined()
    expect(tap.bytes).toBe(1000)
  })

  test("truncates past the limit but keeps counting", () => {
    const tap = new BodyTap(true)
    tap.push("x".repeat(BODY_LIMIT + 500))
    expect(tap.body!.length).toBe(BODY_LIMIT)
    expect(tap.bytes).toBe(BODY_LIMIT + 500)
  })
})

describe("isTextType", () => {
  test("text-ish content types", () => {
    expect(isTextType("application/json; charset=utf-8")).toBe(true)
    expect(isTextType("text/html")).toBe(true)
    expect(isTextType("application/vnd.api+json")).toBe(true)
    expect(isTextType("application/x-www-form-urlencoded")).toBe(true)
  })
  test("binary and absent content types", () => {
    expect(isTextType("image/png")).toBe(false)
    expect(isTextType("application/octet-stream")).toBe(false)
    expect(isTextType(undefined)).toBe(false)
  })
})

describe("redactHeaders", () => {
  test("sensitive values never survive, arrays join, names lowercase", () => {
    const redacted = redactHeaders({
      Authorization: "Bearer secret",
      Cookie: "sid=1",
      "Set-Cookie": ["a=1", "b=2"],
      "X-Api-Key": "k",
      "Content-Type": "application/json",
    })
    expect(redacted["authorization"]).toBe("[redacted]")
    expect(redacted["cookie"]).toBe("[redacted]")
    expect(redacted["set-cookie"]).toBe("[redacted]")
    expect(redacted["x-api-key"]).toBe("[redacted]")
    expect(redacted["content-type"]).toBe("application/json")
  })
})

describe("statusMatcher", () => {
  test("classes, exact codes, error shorthand", () => {
    expect(statusMatcher("5xx")!(503)).toBe(true)
    expect(statusMatcher("5xx")!(404)).toBe(false)
    expect(statusMatcher("422")!(422)).toBe(true)
    expect(statusMatcher("422")!(400)).toBe(false)
    expect(statusMatcher("error")!(404)).toBe(true)
    expect(statusMatcher("error")!(0)).toBe(true)
    expect(statusMatcher("error")!(200)).toBe(false)
    expect(statusMatcher("nope")).toBeUndefined()
  })
})

describe("HttpBuffer", () => {
  test("seq counts up and survives eviction", () => {
    const buffer = new HttpBuffer()
    const fat = "x".repeat(16 * 1024)
    for (let i = 0; i < 100; i++) {
      buffer.record(capture({ ts: i, resBody: fat, resBytes: fat.length }))
    }
    const kept = buffer.slice()
    expect(kept.length).toBeLessThan(100)
    expect(kept.at(-1)!.seq).toBe(99)
    expect(buffer.nextSeq).toBe(100)
  })

  test("slice filters by seq and time", () => {
    const buffer = new HttpBuffer()
    buffer.record(capture({ ts: 10 }))
    buffer.record(capture({ ts: 20 }))
    buffer.record(capture({ ts: 30 }))
    expect(buffer.slice({ sinceSeq: 1 })).toHaveLength(2)
    expect(buffer.slice({ sinceMs: 15, untilMs: 25 })).toHaveLength(1)
  })
})

describe("queryHttp", () => {
  const deck = () => {
    const api = new HttpBuffer()
    api.record(
      capture({
        ts: 100,
        path: "/users/42",
        status: 200,
        reqBody: "req",
        resBody: "res",
        reqHeaders: { host: "x" },
      }),
    )
    api.record(capture({ ts: 300, method: "POST", path: "/orders", status: 422 }))
    const web = new HttpBuffer()
    web.record(capture({ ts: 200, path: "/index.html", status: 200 }))
    return new Map([
      ["api", api],
      ["web", web],
    ])
  }

  test("interleaves by time, reports cursors, strips bodies by default", () => {
    const result = queryHttp(deck(), { limit: 10 })
    expect(result.exchanges.map((e) => `${e.proc}:${e.path}`)).toEqual([
      "api:/users/42",
      "web:/index.html",
      "api:/orders",
    ])
    expect(result.nextSeq).toEqual({ api: 2, web: 1 })
    expect(asHttp(result.exchanges[0]).reqBody).toBeUndefined()
    expect(asHttp(result.exchanges[0]).reqHeaders).toBeUndefined()
  })

  test("bodies come back only when asked", () => {
    const result = queryHttp(deck(), { limit: 10, bodies: true })
    expect(asHttp(result.exchanges[0]).reqBody).toBe("req")
    expect(asHttp(result.exchanges[0]).reqHeaders).toEqual({ host: "x" })
  })

  test("status and path filters, limit keeps the tail", () => {
    expect(queryHttp(deck(), { limit: 10, status: "4xx" }).exchanges).toHaveLength(1)
    expect(queryHttp(deck(), { limit: 10, path: "^/users" }).exchanges).toHaveLength(1)
    const limited = queryHttp(deck(), { limit: 1 })
    expect(limited.exchanges.map((e) => e.path)).toEqual(["/orders"])
    expect(limited.omitted).toBe(2)
  })

  test("throws on unknown proc and bad filters", () => {
    expect(() => queryHttp(deck(), { limit: 1, procs: ["nope"] })).toThrow('unknown proc "nope"')
    expect(() => queryHttp(deck(), { limit: 1, status: "watman" })).toThrow("bad status filter")
    expect(() => queryHttp(deck(), { limit: 1, path: "(" })).toThrow()
  })
})

describe("normalizePath", () => {
  test("collapses ids, keeps words, drops the query string", () => {
    expect(normalizePath("/users/42/orders/7?page=2")).toBe("/users/:id/orders/:id")
    expect(normalizePath("/users/0d9af438-3bc2-4a51-bc26-e15c1e17d0d0")).toBe("/users/:id")
    expect(normalizePath("/blobs/deadbeef1234")).toBe("/blobs/:id")
    expect(normalizePath("/health")).toBe("/health")
  })
})

describe("digestHttp", () => {
  test("groups failures by route, ignores successes, newest group first", () => {
    const groups = digestHttp([
      { ...capture({ ts: 1, path: "/users/1", status: 500 }), proc: "api", seq: 0 },
      { ...capture({ ts: 9, path: "/users/2", status: 500 }), proc: "api", seq: 1 },
      { ...capture({ ts: 5, path: "/ok", status: 200 }), proc: "api", seq: 2 },
      { ...capture({ ts: 20, path: "/dead", status: 0 }), proc: "web", seq: 0 },
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ proc: "web", path: "/dead", status: 0, count: 1 })
    expect(groups[1]).toMatchObject({
      proc: "api",
      path: "/users/:id",
      status: 500,
      count: 2,
      firstTs: 1,
      lastTs: 9,
    })
  })
})
