package wsframe

import (
	"bytes"
	"encoding/binary"
	"slices"
	"testing"
)

type opts struct {
	fin  bool
	mask bool
}

// build builds one RFC 6455 frame.
func build(opcode byte, payload []byte, o opts) []byte {
	first := opcode
	if o.fin {
		first |= 0x80
	}
	var maskBit byte
	if o.mask {
		maskBit = 0x80
	}
	var header []byte
	switch n := len(payload); {
	case n < 126:
		header = []byte{first, maskBit | byte(n)}
	case n < 65536:
		header = binary.BigEndian.AppendUint16([]byte{first, maskBit | 126}, uint16(n))
	default:
		header = binary.BigEndian.AppendUint64([]byte{first, maskBit | 127}, uint64(n))
	}
	if !o.mask {
		return append(header, payload...)
	}
	key := []byte{0x12, 0x34, 0x56, 0x78}
	masked := bytes.Clone(payload)
	for i := range masked {
		masked[i] ^= key[i%4]
	}
	return slices.Concat(header, key, masked)
}

var final = opts{fin: true}

func texts(p *Parser, chunk []byte) []string {
	out := []string{}
	for _, m := range p.Push(chunk) {
		out = append(out, string(m.Data))
	}
	return out
}

func TestPlainTextFrame(t *testing.T) {
	if got := texts(&Parser{}, build(0x1, []byte("hello"), final)); !slices.Equal(got, []string{"hello"}) {
		t.Fatalf("got %q", got)
	}
}

func TestUnmasksClientFrames(t *testing.T) {
	got := texts(&Parser{}, build(0x1, []byte("secret"), opts{fin: true, mask: true}))
	if !slices.Equal(got, []string{"secret"}) {
		t.Fatalf("got %q", got)
	}
}

func TestFramesAcrossChunks(t *testing.T) {
	var p Parser
	two := slices.Concat(build(0x1, []byte("one"), final), build(0x1, []byte("two"), final))
	if got := texts(&p, two); !slices.Equal(got, []string{"one", "two"}) {
		t.Fatalf("two in one chunk: %q", got)
	}
	split := build(0x1, []byte("later"), opts{fin: true, mask: true})
	if got := texts(&p, split[:3]); len(got) != 0 {
		t.Fatalf("partial frame produced %q", got)
	}
	if got := texts(&p, split[3:]); !slices.Equal(got, []string{"later"}) {
		t.Fatalf("rest of frame: %q", got)
	}
}

func TestReassemblesFragments(t *testing.T) {
	parts := slices.Concat(
		build(0x1, []byte("hel"), opts{}),
		build(0x9, []byte("ping"), final), // control frame between fragments — legal
		build(0x0, []byte("lo"), final),
	)
	if got := texts(&Parser{}, parts); !slices.Equal(got, []string{"hello"}) {
		t.Fatalf("got %q", got)
	}
}

func TestBinaryWithExtendedLength(t *testing.T) {
	messages := (&Parser{}).Push(build(0x2, bytes.Repeat([]byte{7}, 300), final))
	if len(messages) != 1 || messages[0].Opcode != "binary" || messages[0].Size != 300 {
		t.Fatalf("got %+v", messages)
	}
}

func TestTruncatesLongMessages(t *testing.T) {
	messages := (&Parser{}).Push(build(0x1, bytes.Repeat([]byte("x"), 70_000), final))
	if len(messages) != 1 || len(messages[0].Data) != messageKeep || messages[0].Size != 70_000 {
		t.Fatalf("kept %d of %d", len(messages[0].Data), messages[0].Size)
	}
}

func TestControlFramesAreNotMessages(t *testing.T) {
	if got := (&Parser{}).Push(slices.Concat(build(0x9, nil, final), build(0x8, nil, final))); len(got) != 0 {
		t.Fatalf("got %+v", got)
	}
}

func TestGoesQuietOnGarbage(t *testing.T) {
	var p Parser
	// RSV bits set = a negotiated extension we know nothing about.
	rsv := build(0x1, []byte("x"), final)
	rsv[0] |= 0x40
	if got := p.Push(rsv); len(got) != 0 {
		t.Fatalf("got %+v", got)
	}
	if got := p.Push(build(0x1, []byte("after"), final)); len(got) != 0 {
		t.Fatal("a broken parser must stay broken")
	}
}

func TestAbsurdLengthBreaks(t *testing.T) {
	header := binary.BigEndian.AppendUint64([]byte{0x82, 127}, 1<<30)
	var p Parser
	if got := p.Push(header); len(got) != 0 || !p.broken {
		t.Fatalf("got %+v, broken = %v", got, p.broken)
	}
}
