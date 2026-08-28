import { afterEach, expect, test } from "vitest"
import { createServer, request as httpRequest } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { startObserver } from "../src/interpose.ts"

/**
 * The observer's forwarding edge cases, exercised directly against
 * `startObserver` — no deck, no CLI: a throwaway target server on a random
 * internal port, the observer on a fixed public one.
 */

const PUBLIC_PORT = 48910

let target: Server | undefined
let closeObserver: (() => Promise<void>) | undefined

afterEach(async () => {
  await closeObserver?.()
  closeObserver = undefined
  await new Promise<void>((resolve) => {
    if (target === undefined) return resolve()
    target.closeAllConnections()
    target.close(() => resolve())
    target = undefined
  })
})

const observe = async (
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<void> => {
  target = createServer(handler)
  const internalPort = await new Promise<number>((resolve) => {
    target!.listen(0, "127.0.0.1", () => {
      resolve((target!.address() as { port: number }).port)
    })
  })
  closeObserver = await startObserver({
    publicPort: PUBLIC_PORT,
    internalPort,
    record: () => {}
  })
}

const until = async (check: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test("a client abort propagates to the upstream", async () => {
  // Without propagation a cancelled browser request (closed tab, aborted
  // fetch) leaves the upstream streaming to completion unseen.
  let upstreamClosed = false
  await observe((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.write("first chunk")
    // …and then keep the response open forever.
    res.on("close", () => {
      upstreamClosed = true
    })
  })

  const req = httpRequest({ host: "127.0.0.1", port: PUBLIC_PORT, path: "/stream" }, (res) => {
    res.once("data", () => req.destroy())
  })
  req.on("error", () => {})
  req.end()

  await until(() => upstreamClosed, "the upstream to see the abort")
})

test("an upstream dying mid-body truncates the response instead of appending an error note", async () => {
  await observe((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.write("partial")
    setTimeout(() => res.socket?.destroy(), 50)
  })

  const outcome = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: PUBLIC_PORT, path: "/dies" }, (res) => {
      let body = ""
      res.on("data", (chunk: Buffer) => (body += chunk.toString()))
      const done = () => resolve({ status: res.statusCode ?? 0, body })
      res.on("end", done)
      res.on("aborted", done)
      res.on("error", done)
    })
    req.on("error", reject)
    req.end()
  })

  expect(outcome.status).toBe(200)
  expect(outcome.body).toBe("partial")
  expect(outcome.body).not.toContain("procdeck")
})

test("forwarded headers identify the original hop", async () => {
  await observe((req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify(req.headers))
  })

  const seen = await new Promise<Record<string, string>>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: PUBLIC_PORT,
        path: "/headers",
        headers: { host: "localhost:3002" }
      },
      (res) => {
        let body = ""
        res.on("data", (chunk: Buffer) => (body += chunk.toString()))
        res.on("end", () => resolve(JSON.parse(body) as Record<string, string>))
      }
    )
    req.on("error", reject)
    req.end()
  })

  expect(seen["x-forwarded-host"]).toBe("localhost:3002")
  expect(seen["x-forwarded-proto"]).toBe("http")
  expect(seen["x-forwarded-for"]).toContain("127.0.0.1")
  expect(seen["host"]).not.toBe("localhost:3002")
})
