import { describe, expect, test } from "vitest"
import { WsMessageParser } from "../src/ws.ts"

/** Build one RFC 6455 frame. */
const frame = (
  opcode: number,
  payload: Buffer | string,
  options: { fin?: boolean; mask?: boolean } = {},
): Buffer => {
  const data = typeof payload === "string" ? Buffer.from(payload) : payload
  const fin = options.fin ?? true
  const mask = options.mask ?? false
  const first = (fin ? 0x80 : 0) | opcode
  const maskBit = mask ? 0x80 : 0

  let header: Buffer
  if (data.length < 126) {
    header = Buffer.from([first, maskBit | data.length])
  } else if (data.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = first
    header[1] = maskBit | 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = first
    header[1] = maskBit | 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }

  if (!mask) return Buffer.concat([header, data])
  const key = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const masked = Buffer.from(data)
  for (let i = 0; i < masked.length; i++) masked[i]! ^= key[i % 4]!
  return Buffer.concat([header, key, masked])
}

const texts = (parser: WsMessageParser, bytes: Buffer): Array<string> =>
  parser.push(bytes).map((message) => message.data.toString())

describe("WsMessageParser", () => {
  test("a plain unmasked text frame", () => {
    expect(texts(new WsMessageParser(), frame(0x1, "hello"))).toEqual(["hello"])
  })

  test("unmasks client frames", () => {
    expect(texts(new WsMessageParser(), frame(0x1, "secret", { mask: true }))).toEqual(["secret"])
  })

  test("several frames in one chunk, one frame across chunks", () => {
    const parser = new WsMessageParser()
    const two = Buffer.concat([frame(0x1, "one"), frame(0x1, "two")])
    expect(texts(parser, two)).toEqual(["one", "two"])
    const split = frame(0x1, "later", { mask: true })
    expect(texts(parser, split.subarray(0, 3))).toEqual([])
    expect(texts(parser, split.subarray(3))).toEqual(["later"])
  })

  test("reassembles fragmented messages, control frames interleave freely", () => {
    const parser = new WsMessageParser()
    const parts = Buffer.concat([
      frame(0x1, "hel", { fin: false }),
      frame(0x9, "ping"), // control frame between fragments — legal
      frame(0x0, "lo", { fin: true }),
    ])
    expect(texts(parser, parts)).toEqual(["hello"])
  })

  test("binary messages carry size, extended 16-bit lengths parse", () => {
    const payload = Buffer.alloc(300, 7)
    const messages = new WsMessageParser().push(frame(0x2, payload))
    expect(messages).toHaveLength(1)
    expect(messages[0]!).toMatchObject({ opcode: "binary", size: 300 })
  })

  test("close and ping frames are not messages", () => {
    const parser = new WsMessageParser()
    expect(parser.push(Buffer.concat([frame(0x9, ""), frame(0x8, "")]))).toEqual([])
  })

  test("goes quiet on garbage instead of guessing", () => {
    const parser = new WsMessageParser()
    // RSV bits set = a negotiated extension we know nothing about.
    const rsv = frame(0x1, "x")
    rsv[0] = rsv[0]! | 0x40
    expect(parser.push(rsv)).toEqual([])
    expect(parser.push(frame(0x1, "after"))).toEqual([]) // stays broken
  })

  test("an absurd declared length breaks the parser rather than buffering it", () => {
    const header = Buffer.alloc(10)
    header[0] = 0x82
    header[1] = 127
    header.writeBigUInt64BE(BigInt(1024 * 1024 * 1024), 2)
    expect(new WsMessageParser().push(header)).toEqual([])
  })
})
