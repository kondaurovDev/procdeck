import { execFile } from "node:child_process"
import { createServer } from "node:net"
import type { AddressInfo, Server } from "node:net"

/**
 * Listening-port discovery for a process group, via `pgrep` + `lsof`.
 *
 * No cooperation from the processes required: the group id is the leader's pid
 * (node-pty starts every proc in its own session), so the OS can enumerate the
 * whole tree — pnpm → vite → workerd — and whatever it listens on. TCP LISTEN
 * only, which is exactly what dev servers are.
 */

const run = (cmd: string, args: Array<string>): Promise<string> =>
  new Promise((resolve) => {
    // Both tools exit non-zero on "no results" — that is data, not an error.
    execFile(cmd, args, (_error, stdout) => resolve(stdout ?? ""))
  })

export const detectPorts = async (pgid: number): Promise<Array<number>> => {
  const pids = (await run("pgrep", ["-g", String(pgid)])).split("\n").filter(Boolean)
  if (pids.length === 0) return []

  const output = await run("lsof", [
    "-a",
    "-P",
    "-n",
    "-iTCP",
    "-sTCP:LISTEN",
    "-p",
    pids.join(",")
  ])

  const ports = new Set<number>()
  for (const line of output.split("\n")) {
    const match = /:(\d+)\s+\(LISTEN\)/.exec(line)
    if (match !== null) ports.add(Number(match[1]))
  }
  return [...ports].sort((a, b) => a - b)
}

export const samePorts = (a: Array<number>, b: Array<number>): boolean =>
  a.length === b.length && a.every((port, i) => port === b[i])

/**
 * Machinery ports a human never opens: node inspectors (9229+) and the macOS
 * ephemeral range, where workerd parks its control sockets. Used to pick the
 * proxy fallback target and mirrored in the UI's link filtering.
 */
export const isInternalPort = (port: number): boolean =>
  port >= 49152 || (port >= 9229 && port <= 9249)

/**
 * Ask the OS for `count` distinct free ports: bind them all on port 0, read
 * the assignments, then release. All sockets stay open until every port is
 * known, so one call cannot hand out duplicates.
 */
export const findFreePorts = async (count: number): Promise<Array<number>> => {
  const servers = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<Server>((resolve, reject) => {
          const server = createServer()
          server.once("error", reject)
          server.listen(0, "127.0.0.1", () => resolve(server))
        })
    )
  )
  const ports = servers.map((server) => (server.address() as AddressInfo).port)
  await Promise.all(
    servers.map((server) => new Promise<void>((done) => server.close(() => done())))
  )
  return ports
}
