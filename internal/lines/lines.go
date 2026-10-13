// Package lines keeps per-proc line buffers — the machine-readable twin of
// the chunk backlog.
//
// The chunk backlog in the supervisor is terminal-oriented: raw PTY output,
// ANSI escapes and all, replayed into xterm. Agents (and the grep filter, the
// merged view, `procdeck errors`) want lines: plain text, timestamped,
// individually addressable by a per-proc seq. One buffer per proc, bounded by
// bytes like the chunk backlog, so a chatty neighbour can't evict anyone
// else's history.
package lines

import (
	"cmp"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
	"unicode"
)

// Line is one completed output line.
type Line struct {
	// Seq is a per-proc counter — a stable cursor for "everything after N".
	Seq int `json:"seq"`
	// TS is the epoch ms of the chunk that completed the line.
	TS   int64  `json:"ts"`
	Text string `json:"text"`
}

// DeckLine is a line attributed to its proc — what multi-proc queries return.
type DeckLine struct {
	Line
	Proc string `json:"proc"`
}

// ansi matches CSI (colors, cursor), OSC (titles, links), DCS/PM/APC strings,
// then any stray two-byte escape. Order matters: the specific forms go first
// so the catch-all can't eat their introducers.
var ansi = regexp.MustCompile(
	`\x1b\[[0-9;?]*[ -/]*[@-~]` +
		`|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)` +
		`|\x1b[PX^_][^\x1b]*\x1b\\` +
		`|\x1b[()#%*+][0-9A-Za-z@]` +
		`|\x1b[^\n\r\x{2028}\x{2029}]`,
)

// controls are the C0 controls that survive escape stripping, except \t \n \r.
var controls = regexp.MustCompile(`[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]`)

// StripANSI removes terminal escapes and stray control characters.
func StripANSI(text string) string {
	return controls.ReplaceAllString(ansi.ReplaceAllString(text, ""), "")
}

const (
	// bufferBytes is the budget per proc — same order as the chunk backlog.
	bufferBytes = 256 * 1024
	// maxLine is where a single line is flushed — no unbounded partials.
	maxLine = 4096
)

// Buffer is one proc's bounded, seq-cursored line history. Not safe for
// concurrent use; the supervisor guards it.
type Buffer struct {
	lines   []Line
	bytes   int
	partial strings.Builder
	seq     int
	// pendingCR holds a chunk's trailing \r: whether it is half of a \r\n or
	// a lone carriage return is only known once the next chunk arrives.
	pendingCR bool
}

// NextSeq is the seq the next completed line will get.
func (b *Buffer) NextSeq() int { return b.seq }

// Push feeds a PTY chunk. "\r\n" and "\n" complete a line; a lone "\r"
// discards the partial — carriage-return progress bars overwrite themselves
// in a terminal, and keeping only the final state is exactly what a reader
// wants (and what keeps a ticking progress bar from flooding the buffer).
func (b *Buffer) Push(data string, ts int64) {
	text := StripANSI(data)
	if b.pendingCR {
		b.pendingCR = false
		if strings.HasPrefix(text, "\n") {
			b.complete(ts)
			text = text[1:]
		} else {
			b.partial.Reset()
		}
	}
	for len(text) > 0 {
		i := strings.IndexAny(text, "\r\n")
		if i < 0 {
			b.append(text, ts)
			return
		}
		b.append(text[:i], ts)
		switch {
		case text[i] == '\n':
			b.complete(ts)
			text = text[i+1:]
		case i+1 == len(text):
			b.pendingCR = true
			return
		case text[i+1] == '\n':
			b.complete(ts)
			text = text[i+2:]
		default:
			b.partial.Reset()
			text = text[i+1:]
		}
	}
}

func (b *Buffer) append(text string, ts int64) {
	if text == "" {
		return
	}
	b.partial.WriteString(text)
	if b.partial.Len() >= maxLine {
		b.complete(ts)
	}
}

func (b *Buffer) complete(ts int64) {
	text := strings.TrimRightFunc(b.partial.String(), unicode.IsSpace)
	b.partial.Reset()
	b.lines = append(b.lines, Line{Seq: b.seq, TS: ts, Text: text})
	b.seq++
	b.bytes += len(text) + 1
	for b.bytes > bufferBytes && len(b.lines) > 1 {
		b.bytes -= len(b.lines[0].Text) + 1
		b.lines = b.lines[1:]
	}
}

// Window bounds a slice of a buffer. Zero values mean "unbounded".
type Window struct {
	SinceSeq int
	SinceMs  int64
	UntilMs  int64
}

func (w Window) contains(seq int, ts int64) bool {
	return seq >= w.SinceSeq && ts >= w.SinceMs && (w.UntilMs == 0 || ts <= w.UntilMs)
}

// Slice returns the lines within the window, oldest first.
func (b *Buffer) Slice(w Window) []Line {
	var out []Line
	for _, line := range b.lines {
		if w.contains(line.Seq, line.TS) {
			out = append(out, line)
		}
	}
	return out
}

// Query selects lines across many procs.
type Query struct {
	// Procs to include; nil means every proc.
	Procs []string
	// SinceSeq narrows per proc: only lines with seq >= SinceSeq[proc].
	SinceSeq map[string]int
	// SinceMs and UntilMs bound the completion time; 0 means unbounded. With
	// both, a window "around T": what was every proc doing at that moment?
	SinceMs int64
	UntilMs int64
	// Grep is a regexp matched against each line, case-insensitively.
	Grep string
	// Limit caps the result to the tail of the matches.
	Limit int
}

// Result is a query's answer.
type Result struct {
	Lines []DeckLine `json:"lines"`
	// NextSeq per requested proc: the seq the next line will get — a resume
	// cursor.
	NextSeq map[string]int `json:"nextSeq"`
	// Omitted counts the matching lines dropped by Limit (the oldest ones).
	Omitted int `json:"omitted"`
}

// Run filters many procs' buffers, interleaves the matches by time and keeps
// the tail. An invalid grep pattern or an unknown proc is an error — callers
// turn it into a 400 or a CLI failure.
func Run(buffers map[string]*Buffer, q Query) (Result, error) {
	var pattern *regexp.Regexp
	if q.Grep != "" {
		compiled, err := regexp.Compile("(?i)" + q.Grep)
		if err != nil {
			return Result{}, fmt.Errorf("bad grep pattern: %w", err)
		}
		pattern = compiled
	}

	ids := q.Procs
	if ids == nil {
		ids = slices.Sorted(maps.Keys(buffers))
	}
	matched := []DeckLine{}
	next := make(map[string]int, len(ids))
	for _, id := range ids {
		buffer, ok := buffers[id]
		if !ok {
			return Result{}, fmt.Errorf("unknown proc %q", id)
		}
		next[id] = buffer.NextSeq()
		for _, line := range buffer.Slice(Window{SinceSeq: q.SinceSeq[id], SinceMs: q.SinceMs, UntilMs: q.UntilMs}) {
			if pattern == nil || pattern.MatchString(line.Text) {
				matched = append(matched, DeckLine{Line: line, Proc: id})
			}
		}
	}

	// Interleave by wall clock; same-millisecond ties keep a stable per-proc
	// order via seq. Cross-proc ordering inside one millisecond is arbitrary.
	slices.SortFunc(matched, func(a, b DeckLine) int {
		return cmp.Or(cmp.Compare(a.TS, b.TS), strings.Compare(a.Proc, b.Proc), cmp.Compare(a.Seq, b.Seq))
	})

	omitted := max(0, len(matched)-q.Limit)
	return Result{Lines: matched[omitted:], NextSeq: next, Omitted: omitted}, nil
}
