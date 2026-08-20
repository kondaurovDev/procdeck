import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { execFile, spawn } from "node:child_process"
import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"

/**
 * `procdeck mcp` end to end: a real deck, a real stdio MCP session speaking
 * newline-delimited JSON-RPC — initialize, tools/list, tools/call. The tools
 * are the CLI verbs, so this only asserts the MCP plumbing and shapes.
 */
const run = promisify(execFile)
const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts")
const PORT = 4879

let home: string
let project: string
let env: NodeJS.ProcessEnv

/** A tiny NDJSON JSON-RPC client over a spawned `procdeck mcp`. */
class McpSession {
  private child: ChildProcessWithoutNullStreams
  private buffer = ""
  private pending = new Map<number, (message: unknown) => void>()
  private nextId = 1

  constructor(...extraArgs: Array<string>) {
    this.child = spawn(process.execPath, [CLI, "mcp", ...extraArgs], { env, cwd: project })
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString()
      let newline: number
      while ((newline = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line.trim().length === 0) continue
        const message = JSON.parse(line) as { id?: number }
        if (message.id !== undefined) this.pending.get(message.id)?.(message)
      }
    })
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const answer = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 15_000)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    return answer
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }

  async handshake(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "procdeck-test", version: "0.0.0" },
    })
    this.notify("notifications/initialized")
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const response = (await this.request("tools/call", { name, arguments: args })) as {
      result?: unknown
    }
    return JSON.stringify(response.result ?? response)
  }

  async toolNames(): Promise<Array<string>> {
    const response = (await this.request("tools/list")) as {
      result?: { tools?: Array<{ name: string }> }
    }
    return (response.result?.tools ?? []).map((tool) => tool.name).sort()
  }

  kill(): void {
    this.child.kill("SIGKILL")
  }
}

beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), "procdeck-mcp-home-"))
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "procdeck-mcp-proj-")))
  env = { ...process.env, PROCDECK_HOME: home }
  writeFileSync(
    path.join(project, "procdeck.config.json"),
    JSON.stringify({
      name: "mcptest",
      port: PORT,
      procs: [
        {
          id: "ticker",
          cmd: [
            "node",
            "-e",
            'console.log("hello-from-mcp"); console.log("TypeError: nope is not a function"); console.log("    at main (index.js:1:1)"); setInterval(() => console.log("tick"), 150)',
          ],
        },
      ],
    }),
  )
  await run(process.execPath, [CLI, "up", "--no-open"], { env, cwd: project })
}, 30_000)

afterAll(async () => {
  await run(process.execPath, [CLI, "down"], { env, cwd: project }).catch(() => undefined)
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

describe("mcp", () => {
  test("read-only session: tools/list, deck_status, mark → logs → errors, wait_for", async () => {
    const session = new McpSession()
    try {
      await session.handshake()

      // Read-only by default — no mutating tools.
      expect(await session.toolNames()).toEqual([
        "deck_status",
        "get_errors",
        "get_logs",
        "set_mark",
        "timeline",
        "wait_for",
      ])

      const status = await session.callTool("deck_status", {})
      expect(status).toContain('"up":true')
      expect(status).toContain('"name":"mcptest"')
      expect(status).toContain('"ticker"')

      const logs = await session.callTool("get_logs", { proc: "ticker", grep: "hello" })
      expect(logs).toContain("hello-from-mcp")

      const errors = await session.callTool("get_errors", { proc: "ticker" })
      expect(errors).toContain("TypeError: nope is not a function")

      await session.callTool("set_mark", { name: "mcp-test" })
      await new Promise((resolve) => setTimeout(resolve, 400))
      const sinceMark = await session.callTool("get_logs", {
        proc: "ticker",
        since_mark: "mcp-test",
      })
      expect(sinceMark).toContain("tick")
      expect(sinceMark).not.toContain("hello-from-mcp")

      const waited = await session.callTool("wait_for", {
        proc: "ticker",
        pattern: "tick",
        timeout_seconds: 10,
      })
      expect(waited).toContain('"ok":true')

      // since_last: every get_logs call advances a session cursor, so the
      // earlier calls above already moved it past the startup lines — a
      // since_last call sees only what arrived after the previous call.
      await session.callTool("get_logs", { proc: "ticker", since_last: true })
      await new Promise((resolve) => setTimeout(resolve, 400))
      const second = await session.callTool("get_logs", { proc: "ticker", since_last: true })
      expect(second).not.toContain("hello-from-mcp")
      expect(second).toContain("tick")

      // timeline: a window around "now" catches the ticker; a window around
      // long-ago catches nothing.
      const now = await session.callTool("timeline", { window_seconds: 5 })
      expect(now).toContain("tick")
      const past = await session.callTool("timeline", { at_ms: 1000, window_seconds: 5 })
      expect(past).toContain('"lines":[]')

      // Problems come back as values, not protocol errors.
      const unknown = await session.callTool("get_logs", { proc: "nope" })
      expect(unknown).toContain("unknown proc")
      expect(unknown).toContain("nope")
    } finally {
      session.kill()
    }
  }, 40_000)

  test("--mutations exposes restart/stop/start and they work", async () => {
    const session = new McpSession("--mutations")
    try {
      await session.handshake()
      const names = await session.toolNames()
      expect(names).toContain("restart_proc")
      expect(names).toContain("stop_proc")
      expect(names).toContain("start_proc")

      const restarted = await session.callTool("restart_proc", { proc: "ticker" })
      expect(restarted).toContain('"ok":true')
      const waited = await session.callTool("wait_for", {
        proc: "ticker",
        pattern: "hello-from-mcp",
        timeout_seconds: 10,
      })
      expect(waited).toContain('"ok":true')
    } finally {
      session.kill()
    }
  }, 40_000)
})
