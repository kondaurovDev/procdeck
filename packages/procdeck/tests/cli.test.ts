import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import { findInstance, isAlive } from "../src/registry.ts"

/**
 * The detached lifecycle end to end, through the real CLI: `up` returns once
 * the deck is reachable and registered, `status`/`ls` read the registry and
 * the API, `down` terminates the whole tree and deregisters. Needs a PTY and
 * a free port like every supervisor test.
 */
const run = promisify(execFile)
const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts")
const PORT = 4877

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

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), "procdeck-cli-home-"))
  // Real path: macOS hands out /var/… for a /private/var/… directory, and the
  // CLI canonicalizes roots.
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "procdeck-cli-proj-")))
  env = { ...process.env, PROCDECK_HOME: home }
  // The registry helpers used by the assertions read the same home.
  process.env["PROCDECK_HOME"] = home
  writeFileSync(
    path.join(project, "procdeck.config.json"),
    JSON.stringify({
      name: "clitest",
      port: PORT,
      procs: [
        { id: "sleeper", cmd: ["node", "-e", "setInterval(() => {}, 1000)"] },
        { id: "done", cmd: ["node", "-e", "process.exit(0)"] },
      ],
    }),
  )
})

afterAll(async () => {
  const instance = findInstance(project)
  if (instance !== undefined) {
    try {
      process.kill(instance.pid, "SIGKILL")
    } catch {
      // Already gone.
    }
  }
  delete process.env["PROCDECK_HOME"]
  rmSync(home, { recursive: true, force: true })
  rmSync(project, { recursive: true, force: true })
})

describe("cli", () => {
  test("up (detached) → status → ls → up again → down", async () => {
    const up = await procdeck("up", "--no-open")
    expect(up.code, up.out).toBe(0)
    expect(up.out).toContain(`"clitest" is up → http://localhost:${PORT}`)

    const instance = findInstance(project)
    expect(instance?.port).toBe(PORT)
    expect(instance?.mode).toBe("detached")
    expect(isAlive(instance!.pid)).toBe(true)

    // The deck answers over HTTP and knows who it is.
    const deck = (await fetch(`http://localhost:${PORT}/__procdeck/api/deck`).then((response) =>
      response.json(),
    )) as { name: string; root: string; port: number }
    expect(deck).toMatchObject({ name: "clitest", root: project, port: PORT })
    const instances = (await fetch(`http://localhost:${PORT}/__procdeck/api/instances`).then(
      (response) => response.json(),
    )) as Array<{ name: string; self: boolean }>
    expect(instances).toEqual([{ name: "clitest", self: true, root: project, port: PORT, startedAt: expect.any(Number) }])

    const status = await procdeck("status")
    expect(status.code, status.out).toBe(0)
    expect(status.out).toContain(`clitest · http://localhost:${PORT}`)
    expect(status.out).toMatch(/sleeper\s+running/)
    expect(status.out).toMatch(/done\s+exit 0/)

    const ls = await procdeck("ls")
    expect(ls.out).toMatch(/clitest\s+:4877\s+up \d+s\s+1\/2 running/)

    // Idempotent — and reports the existing pid.
    const again = await procdeck("up", "--no-open")
    expect(again.code).toBe(0)
    expect(again.out).toContain(`already up → http://localhost:${PORT} (pid ${instance!.pid})`)

    // A second project on the same port is refused before anything spawns.
    const other = mkdtempSync(path.join(tmpdir(), "procdeck-cli-other-"))
    writeFileSync(
      path.join(other, "procdeck.config.json"),
      JSON.stringify({ port: PORT, procs: [{ id: "x", shell: "sleep 100" }] }),
    )
    const clash = await procdeck("up", "--no-open", path.join(other, "procdeck.config.json"))
    expect(clash.code).toBe(1)
    expect(clash.out).toContain(`port ${PORT} is taken by deck "clitest"`)
    rmSync(other, { recursive: true, force: true })

    const down = await procdeck("down")
    expect(down.code, down.out).toBe(0)
    expect(down.out).toContain('stopping "clitest"')
    expect(down.out).toContain("down")
    expect(findInstance(project)).toBeUndefined()
    expect(isAlive(instance!.pid)).toBe(false)

    const downAgain = await procdeck("down")
    expect(downAgain.out).toContain("nothing is up")
    const open = await procdeck("open")
    expect(open.code).toBe(1)
    expect(open.out).toContain("`procdeck up` first")
  }, 40_000)

  test("agent loop: status --json → wait-for → mark → logs --since-mark → errors", async () => {
    const agentProject = realpathSync(mkdtempSync(path.join(tmpdir(), "procdeck-cli-agent-")))
    const inAgent = async (...args: Array<string>) => {
      try {
        const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
          env,
          cwd: agentProject,
        })
        return { code: 0, out: stdout, err: stderr }
      } catch (cause) {
        const failure = cause as { code?: number; stdout?: string; stderr?: string }
        return { code: failure.code ?? 1, out: failure.stdout ?? "", err: failure.stderr ?? "" }
      }
    }
    writeFileSync(
      path.join(agentProject, "procdeck.config.json"),
      JSON.stringify({
        name: "agenttest",
        port: 4878,
        procs: [
          {
            id: "ticker",
            cmd: [
              "node",
              "-e",
              'console.log("hello-from-ticker"); console.log("TypeError: boom is not a function"); console.log("    at main (index.js:1:1)"); setInterval(() => console.log("tick"), 150)',
            ],
          },
          {
            id: "server",
            cmd: [
              "node",
              "-e",
              'setTimeout(() => require("net").createServer().listen(0, () => console.log("server-ready")), 300); setInterval(() => {}, 1000)',
            ],
          },
          { id: "boom", cmd: ["node", "-e", 'console.error("Error: kaboom"); process.exit(1)'] },
        ],
      }),
    )

    try {
      const up = await inAgent("up", "--no-open")
      expect(up.code, up.out + up.err).toBe(0)

      // status --json: machine-readable, with the crashed proc under attention.
      const status = await inAgent("status", "--json")
      expect(status.code, status.err).toBe(0)
      const parsed = JSON.parse(status.out) as {
        up: boolean
        name: string
        attention: Array<{ id: string; reason: string }>
        procs: Array<{ id: string }>
      }
      expect(parsed.up).toBe(true)
      expect(parsed.name).toBe("agenttest")
      expect(parsed.procs.map((proc) => proc.id).sort()).toEqual(["boom", "server", "ticker"])
      expect(parsed.attention).toEqual([{ id: "boom", reason: "exit 1" }])

      // wait-for: a listening port (default) and an output pattern.
      const port = await inAgent("wait-for", "server", "--timeout", "15s")
      expect(port.code, port.out + port.err).toBe(0)
      expect(port.out).toMatch(/"server" is listening on :\d+/)
      const pattern = await inAgent("wait-for", "ticker", "--pattern", "tick", "--timeout", "15s")
      expect(pattern.code, pattern.out + pattern.err).toBe(0)
      expect(pattern.out).toContain('matched /tick/')

      // wait-for a crashed proc fails fast (exit 1), tail on stderr.
      const crashed = await inAgent("wait-for", "boom", "--timeout", "15s")
      expect(crashed.code).toBe(1)
      expect(crashed.err).toContain('"boom" exit 1')
      expect(crashed.err).toContain("kaboom")

      // logs: single proc, grep, interleaved [id] prefixes, --json shape.
      const grep = await inAgent("logs", "ticker", "--grep", "hello")
      expect(grep.code, grep.err).toBe(0)
      expect(grep.out).toContain("hello-from-ticker")
      expect(grep.out).not.toContain("[ticker]")
      const all = await inAgent("logs", "--grep", "hello|server-ready", "--lines", "50")
      expect(all.out).toContain("[ticker] hello-from-ticker")
      const asJson = await inAgent("logs", "ticker", "--grep", "hello", "--json")
      const logsParsed = JSON.parse(asJson.out) as {
        lines: Array<{ proc: string; text: string; seq: number; ts: number }>
        nextSeq: Record<string, number>
        omitted: number
      }
      expect(logsParsed.lines[0]!.text).toBe("hello-from-ticker")
      expect(logsParsed.nextSeq["ticker"]).toBeGreaterThan(0)

      // mark → new output only.
      const mark = await inAgent("mark", "m1")
      expect(mark.code, mark.err).toBe(0)
      await new Promise((resolve) => setTimeout(resolve, 500))
      const sinceMark = await inAgent("logs", "ticker", "--since-mark", "m1")
      expect(sinceMark.code, sinceMark.err).toBe(0)
      expect(sinceMark.out).not.toContain("hello-from-ticker")
      expect(sinceMark.out).toContain("tick")
      const unknownMark = await inAgent("logs", "--since-mark", "nope")
      expect(unknownMark.code).toBe(1)
      expect(unknownMark.err).toContain('unknown mark "nope"')

      // restart <proc>: one process, not the deck — then wait-for catches
      // the fresh run's startup line.
      const restart = await inAgent("restart", "ticker")
      expect(restart.code, restart.out + restart.err).toBe(0)
      expect(restart.out).toContain('"ticker" restarted')
      const fresh = await inAgent("wait-for", "ticker", "--pattern", "hello-from-ticker", "--timeout", "15s")
      expect(fresh.code, fresh.out + fresh.err).toBe(0)
      const unknownProc = await inAgent("restart", "definitely-not-here")
      expect(unknownProc.code).toBe(1)
      expect(unknownProc.err).toContain('unknown proc "definitely-not-here" — one of: ticker')

      // errors: the stack trace is grouped, good news is not reported.
      const errors = await inAgent("errors", "ticker")
      expect(errors.code, errors.err).toBe(0)
      expect(errors.out).toContain("TypeError: boom is not a function")
      expect(errors.out).toContain("at main")
      // 2×: the restart above re-printed the startup error — dedup counted it.
      expect(errors.out).toMatch(/\[ticker\] 2×/)
    } finally {
      await inAgent("down")
      rmSync(agentProject, { recursive: true, force: true })
    }
  }, 60_000)

  test("works from a subdirectory, and reports a bad config in the terminal", async () => {
    const nested = path.join(project, "packages", "web")
    mkdirSync(nested, { recursive: true })
    const status = await run(process.execPath, [CLI, "status"], { env, cwd: nested }).catch(
      (cause: { stdout: string; stderr: string }) => cause,
    )
    expect(status.stderr ?? "").toContain(`nothing is up for ${project}`)

    const bad = path.join(project, "bad.json")
    writeFileSync(bad, JSON.stringify({ procs: [{ id: "x", shell: "true", needs: ["nope"] }] }))
    const up = await procdeck("up", "--no-open", bad)
    expect(up.code).toBe(1)
    expect(up.out).toContain('needs unknown proc "nope"')
    expect(findInstance(project)).toBeUndefined()
  })
})
