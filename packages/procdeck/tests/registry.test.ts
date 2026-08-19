import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import {
  deregister,
  findByPort,
  findInstance,
  instanceId,
  listInstances,
  logPath,
  register,
} from "../src/registry.ts"
import type { Instance } from "../src/registry.ts"

let home: string

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "procdeck-registry-"))
  process.env["PROCDECK_HOME"] = home
})

afterEach(() => {
  delete process.env["PROCDECK_HOME"]
  rmSync(home, { recursive: true, force: true })
})

const instance = (root: string, overrides: Partial<Instance> = {}): Instance => ({
  id: instanceId(root),
  name: path.basename(root),
  root,
  config: path.join(root, "procdeck.config.json"),
  port: 4820,
  pid: process.pid,
  log: logPath(root),
  startedAt: Date.now(),
  version: "0.0.0-test",
  mode: "detached",
  ...overrides,
})

describe("registry", () => {
  test("ids are stable per root and distinct across roots", () => {
    expect(instanceId("/a/b")).toBe(instanceId("/a/b/"))
    expect(instanceId("/a/b")).not.toBe(instanceId("/a/c"))
    expect(instanceId("/a/b")).toHaveLength(12)
  })

  test("register → find → list → deregister", () => {
    register(instance("/proj/alpha"))
    register(instance("/proj/beta", { port: 4830 }))
    expect(findInstance("/proj/alpha")?.name).toBe("alpha")
    expect(findInstance("/proj/gamma")).toBeUndefined()
    expect(listInstances().map((entry) => entry.name)).toEqual(["alpha", "beta"])
    expect(findByPort(4830)?.name).toBe("beta")
    expect(findByPort(1)).toBeUndefined()

    deregister(instanceId("/proj/alpha"))
    expect(findInstance("/proj/alpha")).toBeUndefined()
    expect(listInstances().map((entry) => entry.name)).toEqual(["beta"])
  })

  test("entries whose process is gone are pruned on read", () => {
    // A pid that cannot be alive: the max on Linux is 4194304, macOS far lower.
    register(instance("/proj/dead", { pid: 2_000_000_000 }))
    register(instance("/proj/live"))
    expect(readdirSync(path.join(home, "instances"))).toHaveLength(2)
    expect(listInstances().map((entry) => entry.name)).toEqual(["live"])
    expect(readdirSync(path.join(home, "instances"))).toHaveLength(1)
    expect(findInstance("/proj/dead")).toBeUndefined()
  })

  test("deregister leaves a newer registration by another pid alone", () => {
    register(instance("/proj/x", { pid: process.pid }))
    // Someone else re-registered the same root (a restart raced us).
    register(instance("/proj/x", { pid: process.ppid }))
    deregister(instanceId("/proj/x"), process.pid)
    expect(findInstance("/proj/x")?.pid).toBe(process.ppid)
  })
})
