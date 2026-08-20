import { createServer, request as httpRequest } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { Readable } from "node:stream"
import * as path from "node:path"
import { Effect, Stream } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import type { Scope } from "effect"
import type { ProcEvent } from "./events.ts"
import type { Instance } from "./registry.ts"
import type { Supervisor } from "./supervisor.ts"

const API = "/__procdeck/api"
const HEARTBEAT = "20 seconds"

// The UI is a normal vite app built to ui/dist (`pnpm build`); the server just
// serves the files. UI development runs `pnpm ui:dev` against this API instead.
const distDir = path.join(import.meta.dirname, "..", "ui", "dist")

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
}

const NO_DIST = "procdeck UI is not built — run `pnpm --filter procdeck build` first."

const serveStatic = (pathname: string) =>
  Effect.gen(function* () {
    if (!existsSync(distDir)) {
      return HttpServerResponse.text(NO_DIST, { status: 503 })
    }
    // SPA: anything that is not a file falls back to index.html.
    const relative = pathname === "/" ? "index.html" : pathname.slice(1)
    const resolved = path.join(distDir, relative)
    const file =
      resolved.startsWith(distDir) && existsSync(resolved)
        ? resolved
        : path.join(distDir, "index.html")
    const bytes = yield* Effect.promise(() => readFile(file))
    return HttpServerResponse.uint8Array(bytes, {
      headers: { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" },
    })
  })

/**
 * Server-sent events instead of a WebSocket: the log stream only flows towards
 * the browser, and commands are plain POSTs. The response stream lives in the
 * request scope, so a client disconnect interrupts it and drops the PubSub
 * subscription with it.
 */
const sse = (
  supervisor: Supervisor,
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, Scope.Scope> =>
  Effect.sync(() => {
    const encoder = new TextEncoder()
    const body = supervisor.events.pipe(
      Stream.map((event: ProcEvent) => `data: ${JSON.stringify(event)}\n\n`),
      Stream.merge(Stream.tick(HEARTBEAT).pipe(Stream.map(() => ": ping\n\n"))),
      Stream.map((chunk) => encoder.encode(chunk)),
    )
    return HttpServerResponse.stream(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
      },
    })
  })

/** What the UI needs to know about the deck as a whole. */
export type DeckInfo = {
  name: string
  /** Project root — lets the UI tell "this deck" apart in the registry. */
  root: string
  port: number
  version: string
}

/** Where the server binds. Loopback by default (`host` in the config). */
export type Bind = { host: string; port: number }

/** Deck-wide hooks the CLI wires in; the server only exposes them over HTTP. */
export type ServerHooks = {
  /** Asked by the UI's Shutdown button — the whole deck, not one proc. */
  shutdown: () => void
  /** Every live deck on this machine (the instance registry). */
  instances: () => Array<Instance>
}

/**
 * Web-app manifest, generated per deck so the installed app carries the
 * project's name — every deck is its own origin (port), so its own app.
 * `http://localhost` counts as a secure context: installable without HTTPS.
 * No service worker on purpose: caching a dev tool's UI is a footgun.
 */
const manifest = (deck: DeckInfo) => ({
  name: `${deck.name} · procdeck`,
  short_name: deck.name,
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#0e1116",
  theme_color: "#151a21",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
})

const badRequest = (message: string) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status: 400 })

/** Bounds for one `GET /logs` answer — the line buffers cap memory already. */
const DEFAULT_LOG_LINES = 200
const MAX_LOG_LINES = 5000

/**
 * `GET /logs` — the agent-facing log query (also `procdeck logs`):
 * `procs` (csv, default all), `lines` (tail cap), `grep` (case-insensitive
 * RegExp), `sinceMs`/`untilMs` (epoch window — together, "around T"), `mark`
 * (a named mark's snapshot as the start), `sinceSeq` (resume cursor — an
 * integer for a single proc, or a JSON `{proc: seq}` record for several).
 */
const logsResponse = (supervisor: Supervisor, url: URL) => {
  const param = (name: string) => url.searchParams.get(name) ?? undefined
  const procs = param("procs")?.split(",").filter((id) => id.length > 0)
  const limitRaw = param("lines")
  const limit = limitRaw === undefined ? DEFAULT_LOG_LINES : Number(limitRaw)
  if (!Number.isInteger(limit) || limit < 0) return badRequest(`bad lines: ${limitRaw}`)

  const epoch = (name: string): number | undefined | "bad" => {
    const raw = param(name)
    if (raw === undefined) return undefined
    const value = Number(raw)
    return Number.isFinite(value) ? value : "bad"
  }
  const sinceMs = epoch("sinceMs")
  if (sinceMs === "bad") return badRequest(`bad sinceMs: ${param("sinceMs")}`)
  const untilMs = epoch("untilMs")
  if (untilMs === "bad") return badRequest(`bad untilMs: ${param("untilMs")}`)

  let sinceSeq: Record<string, number> | undefined
  const markName = param("mark")
  if (markName !== undefined) {
    const mark = supervisor.getMark(markName)
    if (mark === undefined) {
      return badRequest(`unknown mark "${markName}" — set one with POST /marks`)
    }
    sinceSeq = mark.seqs
  }
  // Whatever cursor sources combine (mark + explicit), the later one wins
  // per proc — "since" can only move forward.
  const advance = (cursors: Record<string, number>) => {
    sinceSeq = { ...sinceSeq }
    for (const [id, seq] of Object.entries(cursors)) {
      sinceSeq[id] = Math.max(seq, sinceSeq[id] ?? 0)
    }
  }
  const seqRaw = param("sinceSeq")
  if (seqRaw !== undefined) {
    if (seqRaw.startsWith("{")) {
      try {
        const record = JSON.parse(seqRaw) as Record<string, unknown>
        if (Object.values(record).some((seq) => !Number.isInteger(seq))) throw new Error("bad")
        advance(record as Record<string, number>)
      } catch {
        return badRequest(`bad sinceSeq: ${seqRaw} — an integer or a {proc: seq} JSON record`)
      }
    } else {
      const seq = Number(seqRaw)
      if (!Number.isInteger(seq) || procs?.length !== 1) {
        return badRequest("a bare sinceSeq integer needs a single proc in `procs`")
      }
      advance({ [procs[0]!]: seq })
    }
  }

  try {
    return HttpServerResponse.jsonUnsafe(
      supervisor.logs({
        procs,
        sinceSeq,
        sinceMs,
        untilMs,
        grep: param("grep"),
        limit: Math.min(limit, MAX_LOG_LINES),
      }),
    )
  } catch (cause) {
    return badRequest((cause as Error).message)
  }
}

const routes = (supervisor: Supervisor, deck: DeckInfo, hooks: ServerHooks) =>
  HttpRouter.addAll([
    HttpRouter.route("GET", `${API}/deck`, () =>
      Effect.sync(() => HttpServerResponse.jsonUnsafe(deck)),
    ),
    HttpRouter.route("GET", `${API}/instances`, () =>
      Effect.sync(() =>
        HttpServerResponse.jsonUnsafe(
          hooks.instances().map((instance) => ({
            name: instance.name,
            root: instance.root,
            port: instance.port,
            startedAt: instance.startedAt,
            self: instance.root === deck.root,
          })),
        ),
      ),
    ),
    // Answer first, then go down: the UI needs the 200 to know the click
    // landed; the shutdown itself runs through the same path as SIGTERM.
    HttpRouter.route("POST", `${API}/shutdown`, () =>
      Effect.sync(() => {
        setTimeout(hooks.shutdown, 50)
        return HttpServerResponse.jsonUnsafe({ ok: true })
      }),
    ),
    HttpRouter.route("GET", "/manifest.webmanifest", () =>
      Effect.sync(() =>
        HttpServerResponse.text(JSON.stringify(manifest(deck)), {
          headers: { "content-type": "application/manifest+json" },
        }),
      ),
    ),
    HttpRouter.route("GET", `${API}/procs`, () =>
      Effect.sync(() => HttpServerResponse.jsonUnsafe(supervisor.list())),
    ),
    HttpRouter.route("GET", `${API}/logs`, (request) =>
      Effect.sync(() => logsResponse(supervisor, new URL(request.url, "http://localhost"))),
    ),
    HttpRouter.route("POST", `${API}/marks`, (request) =>
      Effect.gen(function* () {
        const body = (yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)))) as {
          name?: string
        } | null
        const name = body?.name ?? "default"
        if (name.length === 0 || name.length > 64) {
          return badRequest("mark name must be 1–64 characters")
        }
        return HttpServerResponse.jsonUnsafe(supervisor.mark(name))
      }),
    ),
    HttpRouter.route("GET", `${API}/events`, () => sse(supervisor)),
    HttpRouter.route("POST", `${API}/procs/:id/:action`, (request) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const id = params["id"] ?? ""
        const body = (yield* request.json.pipe(Effect.catch(() => Effect.succeed(null)))) as {
          cols?: number
          rows?: number
          data?: string
        } | null

        switch (params["action"]) {
          case "start":
            yield* supervisor.start(id)
            break
          case "stop":
            yield* supervisor.stop(id)
            break
          case "restart":
            yield* supervisor.restart(id)
            break
          case "resize":
            supervisor.resize(id, body?.cols ?? 0, body?.rows ?? 0)
            break
          case "input":
            supervisor.write(id, body?.data ?? "")
            break
          default:
            return HttpServerResponse.jsonUnsafe({ error: "unknown action" }, { status: 404 })
        }
        return HttpServerResponse.jsonUnsafe({ ok: true })
      }),
    ),
    // Everything else is the built UI.
    HttpRouter.route("GET", "/", () => serveStatic("/")),
    HttpRouter.route("GET", "/*", (request) =>
      serveStatic(new URL(request.url, "http://localhost").pathname),
    ),
  ])

/**
 * Reverse proxy: `<id>.localhost:<uiPort>` → the pane's real port. One stable,
 * memorable address per pane; which port the process actually got is an
 * implementation detail. Browsers hardcode `*.localhost` → 127.0.0.1, so no
 * /etc/hosts changes are needed. The Host header is rewritten to
 * `localhost:<port>` so dev servers with host allowlists (vite) stay happy.
 *
 * Upstream is dialed as `localhost` with `autoSelectFamily`, not a literal
 * `127.0.0.1`: dev servers bound with `listen(port, "localhost")` on modern
 * Node often end up on `[::1]` only, and a v4-only dial gets ECONNREFUSED
 * while the browser (which tries both families) works fine.
 */
const hostProcId = (host: string | undefined): string | undefined => {
  if (host === undefined) return undefined
  const name = host.split(":")[0]!.toLowerCase()
  return name.endsWith(".localhost") ? name.slice(0, -".localhost".length) : undefined
}

const upstreamOptions = (req: IncomingMessage, port: number) => ({
  host: "localhost",
  port,
  autoSelectFamily: true,
  method: req.method,
  path: req.url,
  headers: { ...req.headers, host: `localhost:${port}` },
})

const refuse = (res: ServerResponse, status: number, message: string) => {
  if (!res.headersSent) res.writeHead(status, { "content-type": "text/plain; charset=utf-8" })
  res.end(`procdeck: ${message}\n`)
}

const proxyRequest = (
  supervisor: Supervisor,
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
): void => {
  const port = supervisor.proxyPort(id)
  if (port === undefined) {
    return refuse(res, 503, `"${id}" has no listening port yet — is it running?`)
  }
  const upstream = httpRequest(upstreamOptions(req, port), (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers)
    upRes.pipe(res)
  })
  upstream.on("error", () => refuse(res, 502, `"${id}" refused the connection on :${port}`))
  req.pipe(upstream)
}

/** WebSocket pass-through — vite HMR and friends live on `Upgrade`. */
const proxyUpgrade = (
  supervisor: Supervisor,
  id: string,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void => {
  const port = supervisor.proxyPort(id)
  if (port === undefined) {
    socket.destroy()
    return
  }

  const upstream = httpRequest(upstreamOptions(req, port))
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    const lines = ["HTTP/1.1 101 Switching Protocols"]
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
      lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`)
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`)
    if (upHead.length > 0) socket.write(upHead)
    if (head.length > 0) upSocket.write(head)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
    const drop = () => {
      upSocket.destroy()
      socket.destroy()
    }
    upSocket.on("error", drop)
    socket.on("error", drop)
  })
  // The upstream answered without upgrading — relay the refusal and hang up.
  upstream.on("response", (upRes) => {
    socket.end(`HTTP/1.1 ${upRes.statusCode ?? 502} ${upRes.statusMessage ?? ""}\r\nconnection: close\r\n\r\n`)
  })
  upstream.on("error", () => socket.destroy())
  socket.on("error", () => upstream.destroy())
  upstream.end()
}

/** Bridge one Node request/response pair to the web-standard handler. */
const handleNode = async (
  handler: (request: Request) => Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const controller = new AbortController()
  // Fires on client disconnect; aborting after a normal finish is a no-op.
  res.on("close", () => controller.abort())

  const method = req.method ?? "GET"
  const request = new Request(`http://localhost${req.url ?? "/"}`, {
    method,
    headers: req.headers as Record<string, string>,
    body:
      method === "GET" || method === "HEAD"
        ? null
        : (Readable.toWeb(req) as unknown as RequestInit["body"]),
    duplex: "half",
    signal: controller.signal,
  } as RequestInit)

  try {
    const response = await handler(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body !== null) {
      for await (const chunk of response.body) {
        res.write(chunk)
      }
    }
    res.end()
  } catch {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  }
}

export const serve = (
  supervisor: Supervisor,
  deck: DeckInfo,
  bind: Bind,
  hooks: ServerHooks,
): Effect.Effect<number, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const { handler, dispose } = HttpRouter.toWebHandler(routes(supervisor, deck, hooks), {
        disableLogger: true,
      })

      // Known pane subdomains are proxied; everything else (plain localhost,
      // unknown names) is the procdeck UI and API.
      const ids = new Set(supervisor.list().map((info) => info.id))

      const http = createServer((req, res) => {
        const id = hostProcId(req.headers.host)
        if (id !== undefined && ids.has(id)) return proxyRequest(supervisor, id, req, res)
        void handleNode(handler, req, res)
      })
      http.on("upgrade", (req, socket, head) => {
        const id = hostProcId(req.headers.host)
        if (id === undefined || !ids.has(id)) return socket.destroy()
        proxyUpgrade(supervisor, id, req, socket, head)
      })

      yield* Effect.callback<void, Error>((resume) => {
        http.once("error", (cause) => resume(Effect.fail(cause)))
        http.listen(bind.port, bind.host, () => resume(Effect.void))
      })

      return { http, dispose }
    }),
    ({ http, dispose }) =>
      Effect.promise(async () => {
        http.closeAllConnections()
        await new Promise<void>((done) => http.close(() => done()))
        await dispose()
      }),
  ).pipe(Effect.as(bind.port))
