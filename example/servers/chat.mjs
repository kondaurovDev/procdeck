import { createServer } from "node:http"
import { createHash } from "node:crypto"

// A dependency-free WebSocket chat — just enough RFC 6455 for a demo. The
// web pane connects to it through `ws://chat.localhost:<ui-port>`; procdeck
// captures every message with direction and text: `procdeck http --ws --body`.
const port = Number(process.env.PORT)

/** One unmasked server → client text frame. */
const encode = (text) => {
  const data = Buffer.from(text)
  if (data.length < 126) return Buffer.concat([Buffer.from([0x81, data.length]), data])
  const header = Buffer.alloc(4)
  header[0] = 0x81
  header[1] = 126
  header.writeUInt16BE(data.length, 2)
  return Buffer.concat([header, data])
}

/** Decode one masked client frame; text comes back, everything else is null. */
const decode = (buffer) => {
  if (buffer.length < 6) return null
  const opcode = buffer[0] & 0x0f
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    length = buffer.readUInt16BE(2)
    offset = 4
  }
  const mask = buffer.subarray(offset, offset + 4)
  const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length))
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
  return opcode === 0x1 ? payload.toString() : null
}

const clients = new Set()
const say = (message) => {
  const frame = encode(JSON.stringify(message))
  for (const client of clients) client.write(frame)
}

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
  res.end("chat speaks WebSocket — open the web pane and say something\n")
})

server.on("upgrade", (req, socket) => {
  const accept = createHash("sha1")
    .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64")
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n" +
      `sec-websocket-accept: ${accept}\r\n\r\n`
  )
  clients.add(socket)
  console.log(`client joined (${clients.size} online)`)
  socket.write(encode(JSON.stringify({ from: "chat", text: "welcome — say something!" })))

  socket.on("data", (chunk) => {
    const text = decode(chunk)
    if (text === null) return
    console.log(`heard: ${text}`)
    say({ from: "guest", text })
    say({ from: "chat", text: `did you say "${text.toUpperCase()}"?` })
  })
  const drop = () => {
    if (clients.delete(socket)) console.log(`client left (${clients.size} online)`)
    socket.destroy()
  }
  socket.on("close", drop)
  socket.on("error", drop)
})

// A heartbeat so the ws capture always has something to show.
let beat = 0
setInterval(() => {
  if (clients.size > 0) say({ from: "chat", text: `heartbeat #${++beat}` })
}, 10_000)

server.listen(port, () => console.log(`chat listening on :${port}`))
