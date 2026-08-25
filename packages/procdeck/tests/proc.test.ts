import { describe, expect, test } from "vitest"
import { isGroupAlive, spawnProc, terminate } from "../src/proc.ts"
import type { SpawnedProc } from "../src/proc.ts"

/**
 * Integration tests against real processes — no mocks on purpose: the risks
 * here (PTY semantics, process groups, signal escalation) live at the OS
 * boundary, which is exactly what a mock would fake away.
 */

const until = async (condition: () => boolean, ms = 5000): Promise<void> => {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("condition not met in time")
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const collect = (spec: Parameters<typeof spawnProc>[0]["spec"]) => {
  let output = ""
  const proc = spawnProc({
    spec,
    root: process.cwd(),
    cols: 80,
    rows: 24,
    onData: (data) => {
      output += data
    }
  })
  return { proc, output: () => output }
}

const expectDead = async (proc: SpawnedProc) => {
  await until(() => !isGroupAlive(proc.pid))
  expect(isGroupAlive(proc.pid)).toBe(false)
}

describe("pty", () => {
  test("children see a real TTY", async () => {
    const { proc, output } = collect({
      id: "tty",
      cmd: ["node", "-p", "Boolean(process.stdout.isTTY)"]
    })
    await proc.exited
    await until(() => output().includes("true"))
  })

  test("shell specs run through the shell", async () => {
    const { proc, output } = collect({
      id: "shell",
      shell: "echo one && echo two"
    })
    await proc.exited
    await until(() => output().includes("one") && output().includes("two"))
  })
})

describe("terminate", () => {
  test("kills the whole tree, not just the leader", async () => {
    // Leader shell stays alive; a grandchild node runs under the same group.
    const { proc } = collect({
      id: "tree",
      shell: `node -e 'setInterval(() => {}, 1000)' & sleep 60`
    })
    await until(() => isGroupAlive(proc.pid))
    await terminate(proc, 1000)
    await expectDead(proc)
  })

  test("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const { proc, output } = collect({
      id: "stubborn",
      cmd: [
        "node",
        "-e",
        'process.on("SIGTERM", () => console.log("ignoring")); console.log("up"); setInterval(() => {}, 1000)'
      ]
    })
    await until(() => output().includes("up"))
    await terminate(proc, 500)
    await expectDead(proc)
  })

  test("kills survivors after the leader is already gone", async () => {
    // The regression from review: leader exits on its own, a signal-ignoring
    // child keeps running in the group. terminate() must still clear it.
    // The child must ignore SIGHUP too: the kernel sends one to the foreground
    // group when the session leader dies, and a child that honours it exits on
    // its own — no survivor left to test against.
    const { proc, output } = collect({
      id: "orphan",
      shell: `node -e 'process.on("SIGTERM", () => {}); process.on("SIGHUP", () => {}); console.log("child-up"); setInterval(() => {}, 1000)' & sleep 0.2`
    })
    await until(() => output().includes("child-up"))
    // Leader (the shell) is done; the group lives on through the child.
    await proc.exited
    expect(isGroupAlive(proc.pid)).toBe(true)

    await terminate(proc, 500)
    await expectDead(proc)
  })

  test("is a no-op on an already dead tree", async () => {
    const { proc } = collect({ id: "gone", cmd: ["node", "-e", ""] })
    await proc.exited
    await until(() => !isGroupAlive(proc.pid))
    await terminate(proc, 500)
  })
})
