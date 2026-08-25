import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Schema } from "effect"
import { ProcdeckConfigSchema } from "../src/config.ts"
import { planInit } from "../src/init.ts"

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "procdeck-init-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const write = (relative: string, content: unknown) => {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content))
}

/** Whatever init writes must load as a deck. */
const valid = (config: unknown) => Schema.decodeUnknownSync(ProcdeckConfigSchema)(config)

describe("procdeck init", () => {
  test("pnpm workspace: one proc per package with a dev script", () => {
    write("package.json", { name: "@acme/monorepo", private: true })
    write("pnpm-lock.yaml", "lockfileVersion: 9\n")
    write("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n  - apps/**\n  - '!**/test/**'\n")
    write("packages/api/package.json", { name: "@acme/api", scripts: { dev: "node server.js" } })
    write("packages/shared/package.json", { name: "@acme/shared", scripts: { build: "tsc" } })
    write("apps/web/package.json", { name: "web", scripts: { dev: "vite" } })
    write("apps/docs/package.json", { name: "docs", scripts: { start: "astro dev" } })

    const plan = planInit(root)
    expect(plan.config.name).toBe("monorepo")
    // Workspace glob order, then directory order; ids drop the scope.
    expect(plan.config.procs).toEqual([
      { id: "api", shell: "pnpm --filter @acme/api dev" },
      { id: "docs", shell: "pnpm --filter docs start" },
      { id: "web", shell: "pnpm --filter web dev" }
    ])
    expect(() => valid(plan.config)).not.toThrow()
    expect(plan.notes.join("\n")).toContain("apps/web")
  })

  test("yarn / npm workspaces from package.json, manager from the lockfile", () => {
    write("package.json", {
      name: "shop",
      workspaces: ["services/*"],
      scripts: { dev: "turbo dev" }
    })
    write("yarn.lock", "")
    write("services/api/package.json", { name: "api", scripts: { dev: "nest start --watch" } })
    write("services/api/package.json", { name: "api", scripts: { dev: "nest start --watch" } })
    write("services/worker/package.json", { name: "worker", scripts: { "start:dev": "tsx w.ts" } })
    // Same name twice in different dirs must not collide.
    write("services/api2/package.json", { name: "api", scripts: { dev: "x" } })

    const plan = planInit(root)
    expect(plan.config.procs.map((proc) => proc.id)).toEqual(["api", "api-2", "worker"])
    expect(plan.config.procs[0]!.shell).toBe("yarn workspace api dev")
    expect(plan.config.procs[2]!.shell).toBe("yarn workspace worker start:dev")
    // The root's own `dev` is not added on top of the per-package panes.
    expect(plan.config.procs).toHaveLength(3)
    expect(() => valid(plan.config)).not.toThrow()
  })

  test("single package: its own dev script through the detected manager", () => {
    write("package.json", { name: "@me/blog", scripts: { dev: "next dev", build: "next build" } })
    write("package-lock.json", "{}")
    const plan = planInit(root)
    expect(plan.config.name).toBe("blog")
    expect(plan.config.procs).toEqual([{ id: "blog", shell: "npm run dev" }])
    expect(() => valid(plan.config)).not.toThrow()
  })

  test("plain subdirectories without a workspace: each its own project and manager", () => {
    write("backend/package.json", { name: "backend", scripts: { dev: "nodemon" } })
    write("backend/pnpm-lock.yaml", "")
    write("frontend/package.json", { name: "@shop/frontend", scripts: { dev: "vite" } })
    write("frontend/yarn.lock", "")
    write("ml/manage.py", "")
    write("gateway/go.mod", "module gateway\n")
    write("docs/README.md", "nothing runnable here")
    write("node_modules/left-pad/package.json", { name: "left-pad", scripts: { dev: "no" } })
    // A root dev script that merely fans out — the per-directory panes win.
    write("package.json", { name: "shop", scripts: { dev: "concurrently ..." } })
    write("package-lock.json", "{}")

    const plan = planInit(root)
    expect(plan.source).toBe("subdirectories")
    expect(plan.config.procs).toEqual([
      { id: "backend", shell: "pnpm run dev", cwd: "backend" },
      { id: "frontend", shell: "yarn run dev", cwd: "frontend" },
      { id: "gateway", shell: "go run .", cwd: "gateway" },
      { id: "ml", shell: "python manage.py runserver", cwd: "ml" }
    ])
    expect(() => valid(plan.config)).not.toThrow()
  })

  test("a subdirectory without its own lockfile uses the root's manager", () => {
    write("pnpm-lock.yaml", "")
    write("api/package.json", { name: "api", scripts: { dev: "tsx watch src" } })
    expect(planInit(root).config.procs).toEqual([{ id: "api", shell: "pnpm run dev", cwd: "api" }])
  })

  test("Procfile wins: it is already the list", () => {
    write(
      "Procfile",
      "web: bundle exec puma -C config/puma.rb\n# a comment\nworker: bundle exec sidekiq\n\n"
    )
    write("bin/rails", "#!/usr/bin/env ruby")
    write("package.json", { name: "app", scripts: { dev: "vite" } })
    const plan = planInit(root)
    expect(plan.source).toBe("Procfile")
    expect(plan.config.procs).toEqual([
      { id: "web", shell: "bundle exec puma -C config/puma.rb" },
      { id: "worker", shell: "bundle exec sidekiq" }
    ])
    expect(() => valid(plan.config)).not.toThrow()
  })

  test("a non-JS root: the one obvious command", () => {
    write("Cargo.toml", '[package]\nname = "svc"\n')
    const plan = planInit(root)
    expect(plan.source).toBe("root")
    expect(plan.config.procs).toEqual([
      { id: path.basename(root).toLowerCase(), shell: "cargo run" }
    ])
    // docker compose at the root, no code of our own → compose it is.
    rmSync(path.join(root, "Cargo.toml"))
    write("compose.yaml", "services: {}")
    expect(planInit(root).config.procs[0]!.shell).toBe("docker compose up")
  })

  test("nothing to go on: a template that still loads", () => {
    const plan = planInit(root)
    expect(plan.source).toBe("template")
    expect(plan.config.name).toBe(path.basename(root))
    expect(plan.config.procs).toHaveLength(1)
    expect(plan.notes[0]).toContain("nothing recognisable")
    expect(() => valid(plan.config)).not.toThrow()
  })
})
