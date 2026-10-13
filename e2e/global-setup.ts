import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import type { TestProject } from "vitest/node"

declare module "vitest" {
  export interface ProvidedContext {
    /** The procdeck binary every suite runs against. */
    procdeckBin: string
  }
}

/**
 * Builds the binary under test once per run — `go build` from the repo root —
 * unless PROCDECK_BIN already names one (CI builds it in an earlier step).
 */
export default function setup(project: TestProject) {
  const given = process.env["PROCDECK_BIN"]
  if (given !== undefined) {
    project.provide("procdeckBin", given)
    return
  }
  const dir = mkdtempSync(path.join(tmpdir(), "procdeck-e2e-"))
  const bin = path.join(dir, "procdeck")
  execFileSync("go", ["build", "-o", bin, "./cmd/procdeck"], {
    cwd: path.join(import.meta.dirname, ".."),
    stdio: "inherit"
  })
  project.provide("procdeckBin", bin)
  return () => rmSync(dir, { recursive: true, force: true })
}
