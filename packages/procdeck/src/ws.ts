/**
 * WebSocket frame parsing (RFC 6455) for the HTTP observer — phase 4 of
 * docs/http-observability.md. Fed the raw socket bytes of one direction
 * *after* the 101 handshake, it emits complete, reassembled messages.
 *
 * The observer strips `Sec-WebSocket-Extensions` from the handshake, so no
 * permessage-deflate is ever negotiated and text frames stay plain text. If
 * the stream still doesn't parse (RSV bits set, absurd lengths, protocol
 * garbage), the parser marks itself broken and goes quiet — capture stops
 * for that connection, the pass-through pipe is never affected.
 */

const CONTINUATION = 0x0
const TEXT = 0x1
const BINARY = 0x2

/**
 * A frame this long is declared broken rather than buffered: capture keeps
 * at most BODY_LIMIT anyway, and waiting on a multi-megabyte blob to parse
 * it would hold the bytes in memory for nothing.
 */
const MAX_FRAME = 4 * 1024 * 1024
/** How much of a reassembled message is kept; `size` counts everything. */
const MESSAGE_KEEP = 16 * 1024

export type WsMessageEvent = {
  opcode: "text" | "binary"
  /** The payload, truncated to MESSAGE_KEEP bytes. */
  data: Buffer
  /** Full message size in bytes, before truncation. */
  size: number
}

type Frame = { fin: boolean; opcode: number; payload: Buffer }

export class WsMessageParser {
  private buffer: Buffer = Buffer.alloc(0)
  private fragments: Array<Buffer> = []
  private fragmentOpcode: number | undefined
  private fragmentSize = 0
  private kept = 0
  private broken = false

  /** Feed raw bytes of one direction; complete messages come back. */
  push(chunk: Buffer): Array<WsMessageEvent> {
    if (this.broken) return []
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const messages: Array<WsMessageEvent> = []
    while (!this.broken) {
      const frame = this.readFrame()
      if (frame === undefined) break
      if (frame === "broken") {
        this.giveUp()
        break
      }
      // Control frames (close/ping/pong) never fragment and never join a
      // message; facts about the connection, not payload — skipped in v1.
      if (frame.opcode >= 0x8) continue
      const message = this.assemble(frame)
      if (message !== undefined) messages.push(message)
    }
    return messages
  }

  private giveUp(): void {
    this.broken = true
    this.buffer = Buffer.alloc(0)
    this.fragments = []
  }

  private assemble(frame: Frame): WsMessageEvent | undefined {
    if (frame.opcode === TEXT || frame.opcode === BINARY) {
      this.fragments = []
      this.fragmentOpcode = frame.opcode
      this.fragmentSize = 0
      this.kept = 0
    } else if (frame.opcode !== CONTINUATION || this.fragmentOpcode === undefined) {
      // Reserved opcode, or a continuation of nothing.
      this.giveUp()
      return undefined
    }
    this.fragmentSize += frame.payload.length
    if (this.kept < MESSAGE_KEEP) {
      const take = frame.payload.subarray(0, MESSAGE_KEEP - this.kept)
      this.fragments.push(take)
      this.kept += take.length
    }
    if (!frame.fin) return undefined
    const message: WsMessageEvent = {
      opcode: this.fragmentOpcode === TEXT ? "text" : "binary",
      data: Buffer.concat(this.fragments),
      size: this.fragmentSize
    }
    this.fragments = []
    this.fragmentOpcode = undefined
    return message
  }

  private readFrame(): Frame | undefined | "broken" {
    const buffer = this.buffer
    if (buffer.length < 2) return undefined
    const fin = (buffer[0]! & 0x80) !== 0
    // RSV bits mean a negotiated extension — we stripped them all, so this
    // is a stream we don't understand.
    if ((buffer[0]! & 0x70) !== 0) return "broken"
    const opcode = buffer[0]! & 0x0f
    const masked = (buffer[1]! & 0x80) !== 0
    let length = buffer[1]! & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < 4) return undefined
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return undefined
      const big = buffer.readBigUInt64BE(2)
      if (big > BigInt(MAX_FRAME)) return "broken"
      length = Number(big)
      offset = 10
    }
    if (length > MAX_FRAME) return "broken"
    const maskStart = offset
    if (masked) offset += 4
    if (buffer.length < offset + length) return undefined
    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    if (masked) {
      const mask = buffer.subarray(maskStart, maskStart + 4)
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!
    }
    this.buffer = buffer.subarray(offset + length)
    return { fin, opcode, payload }
  }
}
