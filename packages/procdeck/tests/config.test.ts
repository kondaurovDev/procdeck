import { describe, expect, test } from "vitest"
import { Schema } from "effect"
import { ProcdeckConfigSchema, resolveSpec, usesOwnPort } from "../src/config.ts"

const decode = Schema.decodeUnknownSync(ProcdeckConfigSchema)

describe("config schema", () => {
  test("accepts a full config", () => {
    const config = decode({
      port: 4820,
      procs: [
        { id: "web", shell: "pnpm dev", url: "http://localhost:2025" },
        { id: "api", cmd: ["node", "server.js"], autostart: false, env: { DEBUG: "1" } },
      ],
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
      /unknown proc/,
    )
  })

  test("rejects dependency cycles", () => {
    expect(() =>
      decode({
        procs: [
          { id: "a", shell: "x", needs: ["b"] },
          { id: "b", shell: "x", needs: ["a"] },
        ],
      }),
    ).toThrow(/cycle/)
  })

  test("rejects duplicate ids", () => {
    expect(() =>
      decode({
        procs: [
          { id: "a", shell: "x" },
          { id: "a", shell: "y" },
        ],
      }),
    ).toThrow(/duplicate/)
  })

  test("accepts preflight and alerts", () => {
    const config = decode({
      procs: [
        {
          id: "api",
          shell: "pnpm dev",
          preflight: { shell: "wrangler whoami", hint: "run pnpm cloudflare:login" },
          alerts: [{ pattern: "Opening a link", label: "needs login" }],
        },
      ],
    })
    expect(config.procs[0]!.preflight?.hint).toBe("run pnpm cloudflare:login")
    expect(config.procs[0]!.alerts).toHaveLength(1)
  })

  test("rejects an alert with an invalid regex", () => {
    expect(() =>
      decode({ procs: [{ id: "x", shell: "x", alerts: [{ pattern: "(", label: "bad" }] }] }),
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
        { id: "web", shell: "web", env: { API_URL: "http://localhost:${port:api}" } },
      ],
    })
    expect(usesOwnPort(config.procs[0]!)).toBe(true)
    expect(usesOwnPort(config.procs[1]!)).toBe(false)
  })

  test("rejects ${port:x} pointing at an unknown proc", () => {
    expect(() =>
      decode({ procs: [{ id: "web", shell: "web ${port:ghost}" }] }),
    ).toThrow(/no proc "ghost"/)
  })

  test("rejects ${port:x} pointing at a proc that does not use ${port}", () => {
    expect(() =>
      decode({
        procs: [
          { id: "api", shell: "serve --port 3000" },
          { id: "web", shell: "web ${port:api}" },
        ],
      }),
    ).toThrow(/does not use/)
  })
})

describe("resolveSpec", () => {
  test("substitutes own and referenced ports across shell, cmd, env and url", () => {
    const config = decode({
      procs: [
        { id: "api", cmd: ["serve", "--port", "${port}"], url: "http://localhost:${port}" },
        { id: "web", shell: "web --port ${port}", env: { API_URL: "http://localhost:${port:api}" } },
      ],
    })
    const assigned = new Map([
      ["api", 50001],
      ["web", 50002],
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
})
