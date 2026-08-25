import { describe, expect, test } from "vitest"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import {
  appendSnippet,
  findInstructionsFile,
  setupAgents,
  SKILL,
  SNIPPET
} from "../src/agent/discover.ts"

const scratch = (): string => mkdtempSync(path.join(tmpdir(), "procdeck-agents-"))

describe("agents discovery", () => {
  test("prefers CLAUDE.md over AGENTS.md, undefined when neither exists", () => {
    const root = scratch()
    try {
      expect(findInstructionsFile(root)).toBeUndefined()
      writeFileSync(path.join(root, "AGENTS.md"), "# agents\n")
      expect(findInstructionsFile(root)).toBe(path.join(root, "AGENTS.md"))
      writeFileSync(path.join(root, "CLAUDE.md"), "# claude\n")
      expect(findInstructionsFile(root)).toBe(path.join(root, "CLAUDE.md"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("appendSnippet adds once, keeps existing content, is idempotent", () => {
    const root = scratch()
    try {
      const file = path.join(root, "CLAUDE.md")
      writeFileSync(file, "# my project\n\nSome rules.\n")
      expect(appendSnippet(file)).toBe("appended")
      const content = readFileSync(file, "utf8")
      expect(content).toContain("# my project")
      expect(content).toContain("## procdeck")
      expect(content).toContain("procdeck status --json")
      expect(appendSnippet(file)).toBe("already-there")
      expect(readFileSync(file, "utf8")).toBe(content)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("setupAgents creates CLAUDE.md when nothing exists, writes the skill, idempotent", () => {
    const root = scratch()
    try {
      const first = setupAgents(root)
      expect(first.join("\n")).toContain('CLAUDE.md — added a "## procdeck" section')
      expect(first.join("\n")).toContain(".claude/skills/procdeck/SKILL.md — written")
      expect(readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toBe(SNIPPET)
      const skillFile = path.join(root, ".claude", "skills", "procdeck", "SKILL.md")
      expect(readFileSync(skillFile, "utf8")).toBe(SKILL)

      const again = setupAgents(root)
      expect(again.join("\n")).toContain("already has")
      expect(again.join("\n")).toContain("already there")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("an existing skill file is never overwritten", () => {
    const root = scratch()
    try {
      const dir = path.join(root, ".claude", "skills", "procdeck")
      setupAgents(root)
      writeFileSync(path.join(dir, "SKILL.md"), "custom\n")
      setupAgents(root)
      expect(readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe("custom\n")
      expect(existsSync(path.join(root, "CLAUDE.md"))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("the snippet and the skill teach the same verbs", () => {
    for (const text of [SNIPPET, SKILL]) {
      for (const verb of ["status --json", "logs", "errors", "mark", "wait-for", "--since-mark"]) {
        expect(text).toContain(verb)
      }
    }
    // The skill has valid-looking frontmatter for Claude Code.
    expect(SKILL.startsWith("---\nname: procdeck\ndescription:")).toBe(true)
  })
})
