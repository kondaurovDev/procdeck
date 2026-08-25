import { describe, expect, test } from "vitest"
import { LineBuffer, queryLogs, stripAnsi } from "../src/lines.ts"

describe("stripAnsi", () => {
  test("removes colors, cursor moves, OSC titles, keeps text", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m plain")).toBe("red plain")
    expect(stripAnsi("\x1b[2K\x1b[1Gprompt")).toBe("prompt")
    expect(stripAnsi("\x1b]0;window title\x07after")).toBe("after")
    expect(stripAnsi("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\")).toBe("link")
    expect(stripAnsi("a\x1b(Bb")).toBe("ab")
  })

  test("keeps newlines, tabs and carriage returns", () => {
    expect(stripAnsi("a\r\nb\tc")).toBe("a\r\nb\tc")
  })

  test("drops stray C0 controls", () => {
    expect(stripAnsi("a\x08b\x00c")).toBe("abc")
  })
})

describe("LineBuffer", () => {
  test("splits chunks into lines across boundaries", () => {
    const buffer = new LineBuffer()
    buffer.push("hel", 1)
    buffer.push("lo\r\nwor", 2)
    buffer.push("ld\n", 3)
    expect(buffer.slice().map((line) => line.text)).toEqual(["hello", "world"])
    // A line is stamped when it completes.
    expect(buffer.slice().map((line) => line.ts)).toEqual([2, 3])
    expect(buffer.slice().map((line) => line.seq)).toEqual([0, 1])
  })

  test("a lone \\r overwrites the partial — progress bars keep only the final state", () => {
    const buffer = new LineBuffer()
    buffer.push("done 10%\rdone 50%\rdone 100%\r\n", 1)
    expect(buffer.slice().map((line) => line.text)).toEqual(["done 100%"])
  })

  test("evicts oldest lines past the byte budget", () => {
    const buffer = new LineBuffer()
    const line = "x".repeat(127)
    for (let i = 0; i < 4096; i++) buffer.push(`${line}${i}\n`, i)
    const kept = buffer.slice()
    expect(kept.length).toBeLessThan(4096)
    expect(kept.at(-1)!.text).toContain("4095")
    // seq keeps counting across evictions — a stable cursor.
    expect(kept.at(-1)!.seq).toBe(4095)
  })

  test("flushes an over-long line instead of growing without bound", () => {
    const buffer = new LineBuffer()
    buffer.push("y".repeat(10_000), 1)
    expect(buffer.slice().length).toBeGreaterThan(0)
  })

  test("slice filters by seq and by time", () => {
    const buffer = new LineBuffer()
    buffer.push("a\n", 10)
    buffer.push("b\n", 20)
    buffer.push("c\n", 30)
    expect(buffer.slice({ sinceSeq: 1 }).map((line) => line.text)).toEqual(["b", "c"])
    expect(buffer.slice({ sinceMs: 25 }).map((line) => line.text)).toEqual(["c"])
  })
})

describe("queryLogs", () => {
  const deck = () => {
    const api = new LineBuffer()
    api.push("listening on :3000\n", 100)
    api.push("GET /users 200\n", 300)
    const web = new LineBuffer()
    web.push("vite ready\n", 200)
    return new Map([
      ["api", api],
      ["web", web]
    ])
  }

  test("interleaves procs by time and reports cursors", () => {
    const result = queryLogs(deck(), { limit: 100 })
    expect(result.lines.map((line) => `${line.proc}:${line.text}`)).toEqual([
      "api:listening on :3000",
      "web:vite ready",
      "api:GET /users 200"
    ])
    expect(result.nextSeq).toEqual({ api: 2, web: 1 })
    expect(result.omitted).toBe(0)
  })

  test("limit keeps the tail and counts the omitted", () => {
    const result = queryLogs(deck(), { limit: 1 })
    expect(result.lines.map((line) => line.text)).toEqual(["GET /users 200"])
    expect(result.omitted).toBe(2)
  })

  test("sinceMs + untilMs make a window around a moment", () => {
    const result = queryLogs(deck(), { limit: 10, sinceMs: 150, untilMs: 250 })
    expect(result.lines.map((line) => line.text)).toEqual(["vite ready"])
  })

  test("grep is case-insensitive, procs and sinceSeq narrow the scan", () => {
    expect(queryLogs(deck(), { limit: 10, grep: "LISTENING" }).lines).toHaveLength(1)
    expect(
      queryLogs(deck(), { limit: 10, procs: ["api"], sinceSeq: { api: 1 } }).lines.map(
        (line) => line.text
      )
    ).toEqual(["GET /users 200"])
  })

  test("throws on unknown proc and bad grep", () => {
    expect(() => queryLogs(deck(), { limit: 10, procs: ["nope"] })).toThrow('unknown proc "nope"')
    expect(() => queryLogs(deck(), { limit: 10, grep: "(" })).toThrow()
  })
})
