import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import { Effect, Schema } from "effect"
import {
  discoverConfig,
  loadConfig,
  ProcdeckConfigSchema,
  resolveSpec,
  usesOwnPort
} from "../src/config.ts"

const decode = Schema.decodeUnknownSync(ProcdeckConfigSchema)

describe("config schema", () => {
  test("accepts a full config", () => {
    const config = decode({
      port: 4820,
      procs: [
        { id: "web", shell: "pnpm dev", url: "http://localhost:2025" },
        { id: "api", cmd: ["node", "server.js"], autostart: false, env: { DEBUG: "1" } }
      ]
    })
    expect(config.procs).toHaveLength(2)
    expect(config.procs[1]!.autostart).toBe(false)
  })

  test("rejects a config without procs", () => {
    expect(() => decode({ port: 1 })).toThrow()
  })

  test("rejects a proc with a non-string id", () => {
    expect(() => decode({ procs: [{ id: 42, shell: "x" }] })).toThrow()
  })

  test("rejects unknown value types in env", () => {
    expect(() => decode({ procs: [{ id: "x", shell: "x", env: { A: 1 } }] })).toThrow()
  })

  test("rejects unknown needs targets", () => {
    expect(() => decode({ procs: [{ id: "a", shell: "x", needs: ["ghost"] }] })).toThrow(
      /unknown proc/
    )
  })

  test("rejects dependency cycles", () => {
    expect(() =>
      decode({
        procs: [
          { id: "a", shell: "x", needs: ["b"] },
          { id: "b", shell: "x", needs: ["a"] }
        ]
      })
    ).toThrow(/cycle/)
  })

  test("rejects duplicate ids", () => {
    expect(() =>
      decode({
        procs: [
          { id: "a", shell: "x" },
          { id: "a", shell: "y" }
        ]
      })
    ).toThrow(/duplicate/)
  })

  test("accepts preflight and alerts", () => {
    const config = decode({
      procs: [
        {
          id: "api",
          shell: "pnpm dev",
          preflight: { shell: "wrangler whoami", hint: "run pnpm cloudflare:login" },
          alerts: [{ pattern: "Opening a link", label: "needs login" }]
        }
      ]
    })
    expect(config.procs[0]!.preflight?.hint).toBe("run pnpm cloudflare:login")
    expect(config.procs[0]!.alerts).toHaveLength(1)
  })

  test("rejects an alert with an invalid regex", () => {
    expect(() =>
      decode({ procs: [{ id: "x", shell: "x", alerts: [{ pattern: "(", label: "bad" }] }] })
    ).toThrow()
  })

  test("requires exactly one of shell / cmd", () => {
    expect(() => decode({ procs: [{ id: "x" }] })).toThrow()
    expect(() => decode({ procs: [{ id: "x", shell: "a", cmd: ["b"] }] })).toThrow()
    expect(() => decode({ procs: [{ id: "x", cmd: [] }] })).toThrow()
  })

  test("accepts ${port} and cross-proc ${port:id} references", () => {
    const config = decode({
      procs: [
        { id: "api", shell: "serve --port ${port}", url: "http://localhost:${port}" },
        { id: "web", shell: "web", env: { API_URL: "http://localhost:${port:api}" } }
      ]
    })
    expect(usesOwnPort(config.procs[0]!)).toBe(true)
    expect(usesOwnPort(config.procs[1]!)).toBe(false)
  })

  test("rejects ${port:x} pointing at an unknown proc", () => {
    expect(() => decode({ procs: [{ id: "web", shell: "web ${port:ghost}" }] })).toThrow(
      /no proc "ghost"/
    )
  })

  test("rejects ${port:x} pointing at a proc that does not use ${port}", () => {
    expect(() =>
      decode({
        procs: [
          { id: "api", shell: "serve --port 3000" },
          { id: "web", shell: "web ${port:api}" }
        ]
      })
    ).toThrow(/does not use/)
  })
})

describe("resolveSpec", () => {
  test("substitutes own and referenced ports across shell, cmd, env and url", () => {
    const config = decode({
      procs: [
        { id: "api", cmd: ["serve", "--port", "${port}"], url: "http://localhost:${port}" },
        { id: "web", shell: "web --port ${port}", env: { API_URL: "http://localhost:${port:api}" } }
      ]
    })
    const assigned = new Map([
      ["api", 50001],
      ["web", 50002]
    ])
    const api = resolveSpec(config.procs[0]!, assigned)
    const web = resolveSpec(config.procs[1]!, assigned)
    expect(api.cmd).toEqual(["serve", "--port", "50001"])
    expect(api.url).toBe("http://localhost:50001")
    expect(web.shell).toBe("web --port 50002")
    expect(web.env?.["API_URL"]).toBe("http://localhost:50001")
  })

  test("leaves unresolvable templates untouched", () => {
    const spec = decode({ procs: [{ id: "a", shell: "x ${port}" }] }).procs[0]!
    expect(resolveSpec(spec, new Map()).shell).toBe("x ${port}")
  })

  test("with an internal map, the proc binds internal but url and cross-refs stay public", () => {
    const config = decode({
      procs: [
        {
          id: "api",
          cmd: ["serve", "--port", "${port}"],
          env: { SELF: "http://localhost:${port:api}" },
          url: "http://localhost:${port}"
        },
        { id: "web", shell: "web ${port}", env: { API_URL: "http://localhost:${port:api}" } }
      ]
    })
    const assigned = new Map([
      ["api", 50001],
      ["web", 50002]
    ])
    const internal = new Map([
      ["api", 60001],
      ["web", 60002]
    ])
    const api = resolveSpec(config.procs[0]!, assigned, internal)
    const web = resolveSpec(config.procs[1]!, assigned, internal)
    // The proc binds the hidden internal port…
    expect(api.cmd).toEqual(["serve", "--port", "60001"])
    // …explicit self-references included — `${port:api}` inside api still
    // means "the port I bind".
    expect(api.env?.["SELF"]).toBe("http://localhost:60001")
    // …but the world reaches it on the public one, through the observer.
    expect(api.url).toBe("http://localhost:50001")
    expect(web.env?.["API_URL"]).toBe("http://localhost:50001")
    expect(web.shell).toBe("web 60002")
  })
})

// Temp decks live next to the tests, not in the OS temp dir: loading a `.mjs`
// config goes through vite-node here, which only serves files under the project
// root.
const scratch: Array<string> = []
const dir = (): string => {
  const created = mkdtempSync(path.join(import.meta.dirname, ".tmp-deck-"))
  scratch.push(created)
  return created
}
const deck = (root: string, file: string, contents: string): string => {
  const target = path.join(root, file)
  writeFileSync(target, contents)
  return target
}

afterAll(() => {
  for (const created of scratch) rmSync(created, { recursive: true, force: true })
})

describe("loadConfig", () => {
  test("loads a JSON config, ignoring the $schema key", async () => {
    const file = deck(
      dir(),
      "procdeck.config.json",
      JSON.stringify({
        $schema: "https://unpkg.com/procdeck/schema.json",
        name: "json-deck",
        procs: [{ id: "api", shell: "serve --port ${port}" }]
      })
    )
    const loaded = await Effect.runPromise(loadConfig(file))
    expect(loaded.name).toBe("json-deck")
    expect(loaded.config.procs).toHaveLength(1)
  })

  test("a JSON config is validated by the same rules as a TS one", async () => {
    const file = deck(
      dir(),
      "procdeck.config.json",
      JSON.stringify({ procs: [{ id: "web", shell: "web", needs: ["ghost"] }] })
    )
    await expect(Effect.runPromise(loadConfig(file))).rejects.toThrow(/unknown proc/)
  })

  test("reports malformed JSON against the file, not as a crash", async () => {
    const file = deck(dir(), "procdeck.config.json", "{ procs: [ }")
    await expect(Effect.runPromise(loadConfig(file))).rejects.toThrow()
  })

  test("loads a JS config through its default export", async () => {
    const file = deck(
      dir(),
      "procdeck.config.mjs",
      'export default { name: "mjs-deck", procs: [{ id: "a", shell: "x" }] }\n'
    )
    const loaded = await Effect.runPromise(loadConfig(file))
    expect(loaded.name).toBe("mjs-deck")
  })

  test("names the deck after its directory when the config does not", async () => {
    const root = dir()
    const file = deck(root, "procdeck.config.json", JSON.stringify({ procs: [] }))
    const loaded = await Effect.runPromise(loadConfig(file))
    expect(loaded.name).toBe(path.basename(root))
    expect(loaded.root).toBe(root)
  })

  test("fails with a plain message when the file is missing", async () => {
    await expect(
      Effect.runPromise(loadConfig(path.join(dir(), "procdeck.config.json")))
    ).rejects.toThrow(/not found/)
  })
})

describe("discoverConfig", () => {
  test("prefers JSON over TypeScript", () => {
    const root = dir()
    writeFileSync(path.join(root, "procdeck.config.ts"), "export default {}")
    writeFileSync(path.join(root, "procdeck.config.json"), "{}")
    expect(discoverConfig(root)).toBe(path.join(root, "procdeck.config.json"))
  })

  test("finds a TypeScript config when there is no JSON one", () => {
    const root = dir()
    writeFileSync(path.join(root, "procdeck.config.ts"), "export default {}")
    expect(discoverConfig(root)).toBe(path.join(root, "procdeck.config.ts"))
  })

  test("returns undefined when the directory has no config", () => {
    expect(discoverConfig(dir())).toBeUndefined()
  })
})
