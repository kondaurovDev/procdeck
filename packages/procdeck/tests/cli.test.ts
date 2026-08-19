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
