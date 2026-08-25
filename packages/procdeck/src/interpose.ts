/**
 * The capture-aware HTTP forwarding shared by procdeck's two interception
 * points (docs/design/http-observability.md):
 *
 * 1. The `*.localhost` reverse proxy in server.ts — browser → service.
 * 2. The per-proc observer started here: procdeck listens on the *public*
 *    assigned port (`${port:api}` resolves to it) and forwards to the hidden
 *    internal port the proc actually binds — transparent server-to-server
 *    capture with zero app changes.
 *
 * Every exchange lands in the proc's `HttpBuffer` via the `record` callback;
 * bodies are teed with `BodyTap` (text-only, truncated), headers are redacted
 * before they are stored.
 */

import { createServer, request as httpRequest } from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import { BodyTap, isTextType, redactHeaders } from "./http-log.ts"
import type { Capture } from "./http-log.ts"
import { WsMessageParser } from "./ws.ts"

export type RecordExchange = (capture: Capture) => void

/**
 * Upstream is dialed as `localhost` with `autoSelectFamily`, not a literal
 * `127.0.0.1`: dev servers bound with `listen(port, "localhost")` on modern
 * Node often end up on `[::1]` only, and a v4-only dial gets ECONNREFUSED
 * while the browser (which tries both families) works fine. The Host header
 * is rewritten to `localhost:<port>` so host allowlists (vite) stay happy.
 */
export const upstreamOptions = (req: IncomingMessage, port: number) => ({
  host: "localhost",
  port,
  autoSelectFamily: true,
  method: req.method,
  path: req.url,
  headers: { ...req.headers, host: `localhost:${port}` }
})

/**
 * Forward one request to `localhost:<port>`, recording the exchange.
 * `record` may be undefined when another tap already sees this traffic (the
 * UI proxy forwarding into an observed public port must not double-count).
 */
export const forwardRequest = (options: {
  req: IncomingMessage
  res: ServerResponse
  port: number
  record: RecordExchange | undefined
  onError?: ((res: ServerResponse) => void) | undefined
}): void => {
  const { port, record, req, res } = options
  const started = Date.now()
  const reqTap =
    record === undefined ? undefined : new BodyTap(isTextType(req.headers["content-type"]))
  if (reqTap !== undefined) req.on("data", (chunk: Buffer) => reqTap.push(chunk))

  let recorded = false
  const finish = (status: number, resTap?: BodyTap, resHeaders?: Record<string, string>) => {
    if (record === undefined || recorded) return
    recorded = true
    record({
      ts: started,
      method: req.method ?? "GET",
      path: req.url ?? "/",
      status,
      durationMs: Date.now() - started,
      reqBytes: reqTap?.bytes ?? 0,
      resBytes: resTap?.bytes ?? 0,
      reqBody: reqTap?.body,
      resBody: resTap?.body,
      reqHeaders: redactHeaders(req.headers),
      resHeaders
    })
  }

  const upstream = httpRequest(upstreamOptions(req, port), (upRes) => {
    const resTap =
      record === undefined ? undefined : new BodyTap(isTextType(upRes.headers["content-type"]))
    if (resTap !== undefined) upRes.on("data", (chunk: Buffer) => resTap.push(chunk))
    upRes.on("end", () => finish(upRes.statusCode ?? 502, resTap, redactHeaders(upRes.headers)))
    upRes.on("close", () => finish(upRes.statusCode ?? 502, resTap, redactHeaders(upRes.headers)))
    res.writeHead(upRes.statusCode ?? 502, upRes.headers)
    upRes.pipe(res)
  })
  upstream.on("error", () => {
    finish(0)
    if (options.onError !== undefined) return options.onError(res)
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
    res.end(`procdeck: upstream refused the connection on :${port}\n`)
  })
  req.pipe(upstream)
}

/** Ties a 101 exchange to the WebSocket messages captured on its socket. */
let nextConnId = 1

/**
 * WebSocket (and any Upgrade) pass-through. The upgrade handshake is recorded
 * as a normal exchange (status 101) carrying a `connId`; every text/binary
 * message on the socket is then captured as a `ws` entry with the same
 * connId (frames parsed and reassembled per RFC 6455 in `ws.ts`).
 */
export const forwardUpgrade = (options: {
  req: IncomingMessage
  socket: Duplex
  head: Buffer
  port: number
  record: RecordExchange | undefined
}): void => {
  const { head, port, record, req, socket } = options
  const started = Date.now()
  const connId = record === undefined ? undefined : nextConnId++
  const path = req.url ?? "/"

  // Where we capture, no compression may be negotiated: stripping the offer
  // makes both sides speak plain frames (permessage-deflate would turn every
  // payload into deflate bytes). Free on loopback.
  if (record !== undefined) delete req.headers["sec-websocket-extensions"]

  const finish = (status: number, resHeaders?: Record<string, string>) => {
    record?.({
      ts: started,
      method: req.method ?? "GET",
      path,
      status,
      durationMs: Date.now() - started,
      reqBytes: 0,
      resBytes: 0,
      reqHeaders: redactHeaders(req.headers),
      resHeaders,
      connId
    })
  }

  const upstream = httpRequest(upstreamOptions(req, port))
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    finish(101, redactHeaders(upRes.headers))
    const lines = ["HTTP/1.1 101 Switching Protocols"]
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
      lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`)
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`)

    // Tap both directions before any post-handshake byte flows: "in" is
    // client → proc, "out" is proc → client. The taps only observe; the
    // pipes below still move the actual bytes.
    let tapIn: ((chunk: Buffer) => void) | undefined
    let tapOut: ((chunk: Buffer) => void) | undefined
    if (record !== undefined && connId !== undefined) {
      const tap = (dir: "in" | "out") => {
        const parser = new WsMessageParser()
        return (chunk: Buffer) => {
          for (const message of parser.push(chunk)) {
            record({
              kind: "ws",
              ts: Date.now(),
              connId,
              dir,
              opcode: message.opcode,
              path,
              size: message.size,
              text: message.opcode === "text" ? message.data.toString("utf8") : undefined
            })
          }
        }
      }
      tapIn = tap("in")
      tapOut = tap("out")
      socket.on("data", tapIn)
      upSocket.on("data", tapOut)
    }

    if (upHead.length > 0) {
      tapOut?.(upHead)
      socket.write(upHead)
    }
    if (head.length > 0) {
      tapIn?.(head)
      upSocket.write(head)
    }
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
    finish(upRes.statusCode ?? 502, redactHeaders(upRes.headers))
    socket.end(
      `HTTP/1.1 ${upRes.statusCode ?? 502} ${upRes.statusMessage ?? ""}\r\nconnection: close\r\n\r\n`
    )
  })
  upstream.on("error", () => {
    finish(0)
    socket.destroy()
  })
  socket.on("error", () => upstream.destroy())
  upstream.end()
}

/**
 * The per-proc observer: listen on the public assigned port, forward to the
 * hidden internal one, record everything. Loopback only, like the assigned
 * ports themselves. Resolves to a close function.
 */
export const startObserver = (options: {
  publicPort: number
  internalPort: number
  record: RecordExchange
}): Promise<() => Promise<void>> => {
  const server = createServer((req, res) =>
    forwardRequest({ req, res, port: options.internalPort, record: options.record })
  )
  server.on("upgrade", (req, socket, head) =>
    forwardUpgrade({ req, socket, head, port: options.internalPort, record: options.record })
  )
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.publicPort, "127.0.0.1", () =>
      resolve(
        () =>
          new Promise<void>((done) => {
            server.closeAllConnections()
            server.close(() => done())
          })
      )
    )
  })
}
