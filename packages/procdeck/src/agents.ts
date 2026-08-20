/**
 * Discovery — how a coding agent learns procdeck exists.
 *
 * MCP tools are self-describing, but the plain CLI is invisible until
 * something tells the agent about it. `procdeck agents` (and `procdeck init`
 * when the project already has agent instructions) plants that knowledge:
 * a short section in CLAUDE.md / AGENTS.md ("know I exist, ask status
 * first") and a Claude Code skill teaching the whole verify loop. The same
 * workflow text as the MCP tool descriptions — distributed into the project
 * instead of served over the protocol.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"

/** The heading doubles as the idempotency marker. */
const MARKER = "## procdeck"

export const SNIPPET = `${MARKER}

Dev processes (servers, watchers) run under procdeck — a process manager with
a web UI, CLI and MCP server. Never start dev servers in ad-hoc terminals:
the deck already runs them (\`procdeck up\` brings it back if it is down).

- \`procdeck status --json\` — ask this first: the \`attention\` list names
  crashed / blocked / alerting procs with reasons.
- \`procdeck logs [proc] [--grep RE] [--since 5m] [--lines N]\` — recent
  output; without \`proc\` every process interleaved with \`[id]\` prefixes.
- \`procdeck errors [proc]\` — recent errors, parsed and deduplicated.
- Verify a change: \`procdeck mark\` → act (edit, \`procdeck restart <proc>\`,
  hit the endpoint) → \`procdeck logs --since-mark default\` shows only what
  your action caused.
- \`procdeck wait-for <proc> [--pattern RE]\` — block until ready after a
  restart; exits 1 fast if it crashed (with the log tail), 2 on timeout.
`

export const SKILL = `---
name: procdeck
description: This project's dev processes (servers, watchers) run under procdeck. Use when checking whether dev processes are healthy, reading their logs, diagnosing crashes or errors, restarting a process, or verifying a code change against the running dev server.
---

# procdeck — the project's dev processes

Every dev process runs under procdeck (web UI + CLI). Never start dev servers
in ad-hoc terminals — the deck already runs them. If nothing is up:
\`procdeck up\` (detaches; the deck outlives the terminal).

## First question

\`procdeck status --json\` — cheap, and its \`attention\` list names every
proc that deserves a look (crashed with exit code, blocked with hint,
alerting) so you skip log-reading when everything is green.

## Reading output

- \`procdeck logs <proc> [--lines N] [--grep RE] [--since 5m]\` — bounded
  tail (default 200 lines); \`--grep\` is a case-insensitive RegExp.
- \`procdeck logs\` (no proc) — every process interleaved, \`[id]\` prefixes.
- \`procdeck errors [proc]\` — errors parsed out of the output and
  deduplicated: "same TypeError, 41×, last 3s ago" plus one sample trace.
  Heuristic — fall back to \`logs --grep\` if it misses something.
- Add \`--json\` to any of these for machine-readable output.

## Verifying a change (the loop that matters)

1. \`procdeck mark\` — drop a marker at "now".
2. Act: edit code, \`procdeck restart <proc>\` if it does not hot-reload.
3. \`procdeck wait-for <proc>\` — until a listening port; or
   \`--pattern "listening"\` for an output line. Crashes fail fast with the
   log tail on stderr (exit 1); timeout is exit 2.
4. Exercise it (curl the endpoint, run the test).
5. \`procdeck logs --since-mark default\` / \`procdeck errors --since-mark
   default\` — only what your action caused.

## Notes

- \`procdeck restart\` (no proc) restarts the whole deck — config edits need
  that; a single proc is cheaper when the code changed.
- Each proc may have a stable address: \`http://<id>.localhost:<ui-port>\`
  (see \`proxyUrl\` in status output).
- MCP alternative: \`claude mcp add procdeck -- procdeck mcp\` exposes these
  as tools (deck_status, get_logs, get_errors, set_mark, wait_for, timeline)
  in every procdeck project at once.
`

/** The instructions file to extend: prefer CLAUDE.md, else AGENTS.md. */
export const findInstructionsFile = (root: string): string | undefined => {
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const file = path.join(root, name)
    if (existsSync(file)) return file
  }
  return undefined
}

/** Append the snippet once; the `## procdeck` heading marks "already done". */
export const appendSnippet = (file: string): "appended" | "already-there" => {
  const current = existsSync(file) ? readFileSync(file, "utf8") : ""
  if (current.includes(MARKER)) return "already-there"
  const glue = current.length === 0 ? "" : current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n"
  appendFileSync(file, `${glue}${SNIPPET}`)
  return "appended"
}

/** Write the Claude Code skill; an existing one is left alone. */
export const writeSkill = (root: string): { outcome: "written" | "already-there"; file: string } => {
  const dir = path.join(root, ".claude", "skills", "procdeck")
  const file = path.join(dir, "SKILL.md")
  if (existsSync(file)) return { outcome: "already-there", file }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, SKILL)
  return { outcome: "written", file }
}

/**
 * `procdeck agents` — set up both rungs of the discovery ladder. Idempotent:
 * running it twice changes nothing. Returns human-readable action lines.
 */
export const setupAgents = (root: string): Array<string> => {
  const actions: Array<string> = []
  const instructions = findInstructionsFile(root) ?? path.join(root, "CLAUDE.md")
  const appended = appendSnippet(instructions)
  actions.push(
    appended === "appended"
      ? `${path.basename(instructions)} — added a "## procdeck" section`
      : `${path.basename(instructions)} — already has a "## procdeck" section, left as is`,
  )
  const skill = writeSkill(root)
  actions.push(
    skill.outcome === "written"
      ? `.claude/skills/procdeck/SKILL.md — written (teaches the mark → act → since-mark loop)`
      : `.claude/skills/procdeck/SKILL.md — already there, left as is`,
  )
  return actions
}
