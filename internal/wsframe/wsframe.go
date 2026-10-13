// Package wsframe parses WebSocket frames (RFC 6455) for the HTTP observer —
// phase 4 of docs/design/http-observability.md. Fed the raw socket bytes of
// one direction after the 101 handshake, it emits complete, reassembled
// messages.
//
// The observer strips Sec-WebSocket-Extensions from the handshake, so no
// permessage-deflate is ever negotiated and text frames stay plain text. If
// the stream still doesn't parse (RSV bits set, absurd lengths, protocol
// garbage), the parser marks itself broken and goes quiet — capture stops for
// that connection, the pass-through pipe is never affected.
package wsframe

import "encoding/binary"

const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2

	// maxFrame is declared broken rather than buffered: capture keeps at most
	// messageKeep anyway, and waiting on a multi-megabyte blob to parse it
	// would hold the bytes in memory for nothing.
	maxFrame = 4 * 1024 * 1024
	// messageKeep is how much of a reassembled message is kept; Size counts
	// everything.
	messageKeep = 16 * 1024
)

// Message is one reassembled data message.
type Message struct {
	// Opcode is "text" or "binary".
	Opcode string
	// Data is the payload, truncated to 16 KB.
	Data []byte
	// Size is the full message size before truncation.
	Size int
}

// Parser reassembles messages from one direction of a connection. The zero
// value is ready to use.
type Parser struct {
	buf []byte
	// open is true between a message's first frame and its fin frame.
	open         bool
	fragmentOp   int
	fragments    []byte
	fragmentSize int
	broken       bool
}

type frame struct {
	fin     bool
	opcode  int
	payload []byte
}

// Push feeds raw bytes of one direction; complete messages come back.
func (p *Parser) Push(chunk []byte) []Message {
	if p.broken {
		return nil
	}
	p.buf = append(p.buf, chunk...)
	var messages []Message
	for !p.broken {
		f, ok, broken := p.readFrame()
		if broken {
			p.giveUp()
			break
		}
		if !ok {
			break
		}
		// Control frames (close/ping/pong) never fragment and never join a
		// message; facts about the connection, not payload — skipped.
		if f.opcode >= 0x8 {
			continue
		}
		if message, done := p.assemble(f); done {
			messages = append(messages, message)
		}
	}
	if len(p.buf) == 0 {
		p.buf = nil // drop the backing array between bursts
	}
	return messages
}

func (p *Parser) giveUp() {
	p.broken = true
	p.buf, p.fragments = nil, nil
}

func (p *Parser) assemble(f frame) (Message, bool) {
	switch {
	case f.opcode == opText || f.opcode == opBinary:
		p.open, p.fragmentOp, p.fragments, p.fragmentSize = true, f.opcode, p.fragments[:0], 0
	case f.opcode != opContinuation || !p.open:
		// Reserved opcode, or a continuation of nothing.
		p.giveUp()
		return Message{}, false
	}
	p.fragmentSize += len(f.payload)
	if room := messageKeep - len(p.fragments); room > 0 {
		p.fragments = append(p.fragments, f.payload[:min(room, len(f.payload))]...)
	}
	if !f.fin {
		return Message{}, false
	}
	opcode := "binary"
	if p.fragmentOp == opText {
		opcode = "text"
	}
	message := Message{Opcode: opcode, Data: append([]byte(nil), p.fragments...), Size: p.fragmentSize}
	p.open, p.fragments = false, p.fragments[:0]
	return message, true
}

// readFrame takes one complete frame off the buffer. ok is false while the
// frame is still incomplete; broken reports a stream we don't understand.
func (p *Parser) readFrame() (f frame, ok, broken bool) {
	buf := p.buf
	if len(buf) < 2 {
		return frame{}, false, false
	}
	// RSV bits mean a negotiated extension — we stripped them all.
	if buf[0]&0x70 != 0 {
		return frame{}, false, true
	}
	fin := buf[0]&0x80 != 0
	opcode := int(buf[0] & 0x0f)
	masked := buf[1]&0x80 != 0
	length := uint64(buf[1] & 0x7f)
	offset := 2
	switch length {
	case 126:
		if len(buf) < 4 {
			return frame{}, false, false
		}
		length, offset = uint64(binary.BigEndian.Uint16(buf[2:])), 4
	case 127:
		if len(buf) < 10 {
			return frame{}, false, false
		}
		length, offset = binary.BigEndian.Uint64(buf[2:]), 10
	}
	if length > maxFrame {
		return frame{}, false, true
	}
	maskStart := offset
	if masked {
		offset += 4
	}
	end := offset + int(length)
	if len(buf) < end {
		return frame{}, false, false
	}
	payload := append([]byte(nil), buf[offset:end]...)
	if masked {
		mask := buf[maskStart : maskStart+4]
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	p.buf = buf[end:]
	return frame{fin: fin, opcode: opcode, payload: payload}, true, false
}
