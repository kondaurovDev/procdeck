import { describe, expect, test } from "vitest"
import { extractErrors, signatureOf } from "../src/agent/errors.ts"
import type { DeckLogLine } from "../src/lines.ts"

const lines = (proc: string, texts: Array<string>, startTs = 0): Array<DeckLogLine> =>
  texts.map((text, index) => ({ proc, seq: index, ts: startTs + index, text }))

describe("signatureOf", () => {
  test("collapses ports, counters, hex and case", () => {
    expect(signatureOf("Error: EADDRINUSE :3000")).toBe(signatureOf("error: EADDRINUSE :4000"))
    expect(signatureOf("worker 0x1a2b3c died")).toBe(signatureOf("worker 0xffee11 died"))
    expect(signatureOf("retry 12 failed")).toBe(signatureOf("retry 99  failed"))
  })
})

describe("extractErrors", () => {
  test("groups a JS stack trace with its frames", () => {
    const groups = extractErrors(
      lines("api", [
        "GET /users 200",
        "TypeError: Cannot read properties of undefined (reading 'id')",
        "    at handler (src/routes.ts:42:11)",
        "    at process.processTicksAndRejections (node:internal:95:5)",
        "GET /users 500",
      ]),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.sample[0]).toContain("TypeError")
    expect(groups[0]!.sample).toHaveLength(3)
  })

  test("python traceback: the message line after the frames names the group", () => {
    const groups = extractErrors(
      lines("worker", [
        "Traceback (most recent call last):",
        '  File "app.py", line 10, in <module>',
        "    main()",
        "ValueError: bad input 42",
      ]),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.signature).toContain("valueerror")
  })

  test("dedupes repeats and counts them, keeping first/last timestamps", () => {
    const first = lines("api", ["Error: connect ECONNREFUSED 127.0.0.1:5432"], 100)
    const second = lines("api", ["Error: connect ECONNREFUSED 127.0.0.1:5432"], 900)
    const groups = extractErrors([...first, ...second])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.count).toBe(2)
    expect(groups[0]!.firstTs).toBe(100)
    expect(groups[0]!.lastTs).toBe(900)
  })

  test("same message in different procs stays separate", () => {
    const groups = extractErrors([
      ...lines("api", ["Error: boom"], 1),
      ...lines("web", ["Error: boom"], 2),
    ])
    expect(groups).toHaveLength(2)
  })

  test("good news is not an error", () => {
    const groups = extractErrors(
      lines("web", ["✓ built in 1.2s", "0 errors, 0 warnings", "test suite passed"]),
    )
    expect(groups).toHaveLength(0)
  })

  test("most recent errors come first", () => {
    const groups = extractErrors([
      ...lines("api", ["Error: old problem"], 10),
      ...lines("api", ["Error: new problem"], 500),
    ])
    expect(groups.map((group) => group.signature)).toEqual([
      "error: new problem",
      "error: old problem",
    ])
  })
})
