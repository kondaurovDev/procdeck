/**
 * Plumbing shared by every CLI command: the one-line failure type, config
 * resolution (explicit path or config-walk up from the cwd), the running
 * instance lookup, and small formatting helpers.
 */

import { existsSync, realpathSync } from "node:fs"
import * as path from "node:path"
import { Data, Effect, Option } from "effect"
import { Argument, Flag } from "effect/unstable/cli"
import { fetchProcs as fetchProcsRaw } from "../agent/client.ts"
import { CONFIG_FILENAMES, loadConfig, locateConfig } from "../config.ts"
import type { ProcInfo } from "../events.ts"
import { pretty } from "../lifecycle.ts"
import { findInstance } from "../registry.ts"
import type { Instance } from "../registry.ts"

/** A user-facing failure: printed as one line, exit code 1, no stack. */
export class CliFailure extends Data.TaggedError("CliFailure")<{
  message: string
  code?: number | undefined
}> {}
export const fail = (message: string, code?: number) => new CliFailure({ message, code })

/** A deck API promise as a CLI step: any thrown message is the failure line. */
export const callApi = <T>(thunk: () => Promise<T>): Effect.Effect<T, CliFailure> =>
  Effect.tryPromise({ try: thunk, catch: (cause) => fail((cause as Error).message) })

/** The config file: the given path, else the nearest one up from the cwd. */
export const resolveConfig = (configArg: Option.Option<string>) =>
  Effect.gen(function* () {
    const found = Option.isSome(configArg)
      ? path.resolve(configArg.value)
      : locateConfig(process.cwd())
    if (found === undefined) {
      return yield* fail(
        `no config file here or above — expected one of ${CONFIG_FILENAMES.join(", ")} (or pass a path)`,
      )
    }
    if (!existsSync(found)) return yield* fail(`config file not found: ${found}`)
    // Real path: the project's identity must not depend on symlinks in the
    // way the config was reached (`/var` vs `/private/var` on macOS).
    return realpathSync(found)
  })

export const load = (configPath: string) =>
  loadConfig(configPath).pipe(
    Effect.mapError((error) => fail(`${pretty(error.file)}: ${error.message}`)),
  )

/** The project root for `down|status|open|logs`: where the config lives. */
export const resolveRoot = (configArg: Option.Option<string>) =>
  resolveConfig(configArg).pipe(Effect.map(path.dirname))

/** The running deck for the current project, or a one-line failure. */
export const requireInstance = (configArg: Option.Option<string>) =>
  Effect.gen(function* () {
    const root = yield* resolveRoot(configArg)
    const instance = findInstance(root)
    if (instance === undefined) {
      return yield* fail(`nothing is up for ${pretty(root)} — \`procdeck up\` first`)
    }
    return instance
  })

/** The deck's procs, straight from its API. `undefined` when it does not answer. */
export const fetchProcs = (instance: Instance): Effect.Effect<Array<ProcInfo> | undefined> =>
  Effect.promise(() => fetchProcsRaw(instance))

/** "30s" / "5m" / "2h" / bare seconds → ms. `undefined` = unparsable. */
export const parseDuration = (raw: string): number | undefined => {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(raw.trim())
  if (match === null) return undefined
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? "s"]!
  return Number(match[1]) * scale
}

export const describeUptime = (since: number): string => {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
}

export const countRunning = (procs: Array<ProcInfo> | undefined): string =>
  procs === undefined
    ? "not answering"
    : `${procs.filter((info) => info.status.state === "running").length}/${procs.length} running`

export const table = (rows: Array<Array<string>>): string => {
  const widths = rows.reduce<Array<number>>(
    (acc, row) => row.map((cell, i) => Math.max(acc[i] ?? 0, cell.length)),
    [],
  )
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n")
}

export const configArgument = Argument.string("config").pipe(
  Argument.optional,
  Argument.withDescription(
    `config file (default: the nearest ${CONFIG_FILENAMES[0]} / .ts / .js / .mjs up from the current directory)`,
  ),
)

export const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("machine-readable output (for agents and scripts)"),
)
