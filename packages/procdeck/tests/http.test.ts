import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { execFile } from "node:child_process"
import { request as httpRequest } from "node:http"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import type { DeckCapture, HttpDigestGroup, HttpExchange, HttpResult } from "../src/http-log.ts"

/** Most assertions look at http entries; make the union access explicit. */
const asHttp = (capture: DeckCapture | undefined): HttpExchange => {
  expect(capture).toBeDefined()
  expect(capture!.kind).not.toBe("ws")
  return capture as HttpExchange
}

/**
 * The HTTP observer end to end (docs/http-observability.md): a real deck with
 * one interposed proc (traffic through the observer on the public assigned
 * port) and one opted out (traffic captured by the `*.localhost` proxy tap),
 * queried through the real `procdeck http` CLI.
 */
const run = promisify(execFile)
const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts")
const PORT = 4880

let home: string
let project: string
let env: NodeJS.ProcessEnv

const procdeck = async (...args: Array<string>) => {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env, cwd: project })
    return { code: 0, out: stdout + stderr }
  } catch (cause) {
    const failure = cause as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? 1, out: (failure.stdout ?? "") + (failure.stderr ?? "") }
  }
}

/** Plain node:http client — fetch would refuse a spoofed Host header. */
const call = (options: {
  port: number
  path: string
  method?: string
  headers?: Record<string, string>
  body?: string
}): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: options.port,
        method: options.method ?? "GET",
        path: options.path,
        headers: options.headers ?? {},
      },
      (res) => {
        let body = ""
        res.on("data", (chunk: Buffer) => (body += chunk.toString()))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on("error", reject)
    req.end(options.body)
  })

/**
 * A tiny echo server bound to PORT — CommonJS, `node -e` runs it as such.
 * Speaks just enough WebSocket to test capture: accepts any upgrade, greets
 * with a text frame, ignores whatever the client sends (the observer parses
 * the client's masked frames on the wire regardless).
 */
const SERVER = `
const http = require("http");
const crypto = require("crypto");
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const fail = /^\\/(missing|boom)/.exec(req.url);
    const status = fail === null ? 200 : fail[1] === "missing" ? 404 : 500;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ url: req.url, method: req.method, body }));
  });
});
srv.on("upgrade", (req, socket) => {
  const accept = crypto.createHash("sha1")
    .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nupgrade: websocket\\r\\n" +
    "connection: Upgrade\\r\\nsec-websocket-accept: " + accept + "\\r\\n\\r\\n");
  const greeting = Buffer.from("welcome");
  socket.write(Buffer.concat([Buffer.from([0x81, greeting.length]), greeting]));
  socket.on("data", () => {});
  socket.on("error", () => {});
});
srv.listen(process.env.PORT, () => console.log("serving on " + process.env.PORT));
`.trim()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const httpJson = async (...args: Array<string>): Promise<HttpResult> => {
  const result = await procdeck("http", ...args, "--json")
  expect(result.code).toBe(0)
  return JSON.parse(result.out) as HttpResult
}

let apiPort = 0
let rawPort = 0

beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), "procdeck-http-home-"))
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "procdeck-http-proj-")))
  env = { ...process.env, PROCDECK_HOME: home }
  writeFileSync(
    path.join(project, "procdeck.config.json"),
    JSON.stringify({
      name: "httptest",
      port: PORT,
      procs: [
        { id: "api", cmd: ["node", "-e", SERVER], env: { PORT: "${port}" } },
        { id: "raw", cmd: ["node", "-e", SERVER], env: { PORT: "${port}" }, observe: false },
      ],
    }),
  )
  await run(process.execPath, [CLI, "up", "--no-open"], { env, cwd: project })
  await run(process.execPath, [CLI, "wait-for", "api", "--pattern", "serving on"], {
    env,
    cwd: project,
  })
  await run(process.execPath, [CLI, "wait-for", "raw", "--pattern", "serving on"], {
    env,
    cwd: project,
  })
  const status = await procdeck("status", "--json")
  const report = JSON.parse(status.out) as {
    procs: Array<{ id: string; assignedPort?: number }>
  }
  apiPort = report.procs.find((proc) => proc.id === "api")!.assignedPort!
  rawPort = report.procs.find((proc) => proc.id === "raw")!.assignedPort!
}, 40_000)

afterAll(async () => {
  await run(process.execPath, [CLI, "down"], { env, cwd: project }).catch(() => undefined)
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

describe("http observer", () => {
  test("the assigned port is the observer: traffic through it is served and captured", async () => {
    const answer = await call({ port: apiPort, path: "/hello" })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toMatchObject({ url: "/hello", method: "GET" })
    await sleep(150)

    const result = await httpJson("api")
    const hello = asHttp(result.exchanges.find((e) => e.path === "/hello"))
    expect(hello).toMatchObject({ proc: "api", method: "GET", status: 200 })
    expect(hello.durationMs).toBeGreaterThanOrEqual(0)
    expect(hello.resBytes).toBeGreaterThan(0)
    // Bodies stay out of the answer unless asked for.
    expect(hello.resBody).toBeUndefined()
    expect(hello.reqHeaders).toBeUndefined()
  })

  test("an opted-out proc is still captured by the *.localhost proxy tap", async () => {
    // observe: false → the proc binds the public port itself…
    const direct = await call({ port: rawPort, path: "/direct" })
    expect(direct.status).toBe(200)
    // …and only proxied traffic is seen.
    const proxied = await call({
      port: PORT,
      path: "/proxied",
      headers: { host: `raw.localhost:${PORT}` },
    })
    expect(proxied.status).toBe(200)
    await sleep(150)

    const result = await httpJson("raw")
    expect(result.exchanges.map((e) => e.path)).toContain("/proxied")
    expect(result.exchanges.map((e) => e.path)).not.toContain("/direct")
  })

  test("browser traffic through <id>.localhost is captured once, by the observer", async () => {
    const before = (await httpJson("api")).nextSeq["api"]!
    const answer = await call({
      port: PORT,
      path: "/via-proxy",
      headers: { host: `api.localhost:${PORT}` },
    })
    expect(answer.status).toBe(200)
    await sleep(150)
    const result = await httpJson("api")
    const captured = result.exchanges.filter((e) => e.path === "/via-proxy")
    expect(captured).toHaveLength(1)
    expect(result.nextSeq["api"]).toBe(before + 1)
  })

  test("bodies on request: text captured and truncatable, auth headers redacted", async () => {
    await call({
      port: apiPort,
      path: "/echo",
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer very-secret",
      },
      body: JSON.stringify({ secret: "payload-42" }),
    })
    await sleep(150)

    const result = await httpJson("api", "--path", "^/echo$", "--body")
    const echo = asHttp(result.exchanges.at(-1))
    expect(echo.reqBody).toContain("payload-42")
    expect(echo.resBody).toContain("payload-42") // the server echoes it back
    expect(echo.reqHeaders?.["authorization"]).toBe("[redacted]")
    expect(echo.reqHeaders?.["content-type"]).toBe("application/json")
  })

  test("mark → act → --since-mark shows only what the action caused", async () => {
    await call({ port: apiPort, path: "/before-mark" })
    await sleep(150)
    expect((await procdeck("mark")).code).toBe(0)
    await call({ port: apiPort, path: "/after-mark" })
    await sleep(150)

    const result = await httpJson("--since-mark", "default")
    const paths = result.exchanges.map((e) => e.path)
    expect(paths).toContain("/after-mark")
    expect(paths).not.toContain("/before-mark")
  })

  test("status filter narrows to failures", async () => {
    await call({ port: apiPort, path: "/missing/thing" })
    await sleep(150)
    const notFound = await httpJson("api", "--status", "404")
    expect(notFound.exchanges.length).toBeGreaterThan(0)
    expect(notFound.exchanges.every((e) => asHttp(e).status === 404)).toBe(true)
    const serverErrors = await httpJson("api", "--status", "5xx", "--path", "^/missing")
    expect(serverErrors.exchanges).toHaveLength(0)
  })

  test("digest groups failures by normalized route", async () => {
    await call({ port: apiPort, path: "/boom/1" })
    await call({ port: apiPort, path: "/boom/2" })
    await sleep(150)
    const result = await procdeck("http", "api", "--digest", "--json")
    expect(result.code).toBe(0)
    const digest = (JSON.parse(result.out) as { digest: Array<HttpDigestGroup> }).digest
    const boom = digest.find((group) => group.path === "/boom/:id")
    expect(boom).toMatchObject({ proc: "api", method: "GET", status: 500, count: 2 })
  })

  test("websocket messages are captured with direction, text and a shared connId", async () => {
    // Node's built-in WebSocket client (undici) — it offers permessage-
    // deflate, which the observer strips so the frames stay readable.
    const ws = new WebSocket(`ws://127.0.0.1:${apiPort}/chat?room=7`)
    const welcome = new Promise<string>((resolve) => {
      ws.onmessage = (event) => resolve(String(event.data))
    })
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error("ws failed to connect"))
    })
    ws.send("hello from client")
    expect(await welcome).toBe("welcome")
    await sleep(200)
    ws.close()

    const result = await httpJson("api", "--ws", "--body")
    const messages = result.exchanges.filter((e) => e.kind === "ws")
    expect(messages.length).toBeGreaterThanOrEqual(2)
    const outbound = messages.find((m) => m.dir === "out" && m.text === "welcome")
    const inbound = messages.find((m) => m.dir === "in" && m.text === "hello from client")
    expect(outbound).toMatchObject({ proc: "api", opcode: "text", path: "/chat?room=7" })
    expect(inbound).toMatchObject({ proc: "api", opcode: "text", size: 17 })
    expect(inbound!.connId).toBe(outbound!.connId)

    // The upgrade itself is a normal exchange (101) with the same connId…
    const upgrade = asHttp(
      (await httpJson("api", "--path", "^/chat")).exchanges.find((e) => e.kind !== "ws"),
    )
    expect(upgrade.status).toBe(101)
    expect(upgrade.connId).toBe(inbound!.connId)

    // …and message text stays out of the answer unless --body asks for it.
    const lean = await httpJson("api", "--ws")
    expect(lean.exchanges.every((e) => e.kind === "ws" && e.text === undefined)).toBe(true)
  })

  test("human output reads as one line per exchange", async () => {
    const result = await procdeck("http", "api", "--path", "^/hello$")
    expect(result.code).toBe(0)
    expect(result.out).toMatch(/GET \/hello → 200 \d+ms/)
  })
})
