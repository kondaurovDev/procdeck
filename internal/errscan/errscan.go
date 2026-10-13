// Package errscan extracts errors from line buffers — `procdeck errors`.
//
// Heuristics, not parsers: find lines that start an error (message, traceback
// header, panic), attach the frame lines that follow, and dedupe repeats by a
// normalized signature. Far cheaper for an agent's context than raw logs —
// "same TypeError, 41×, last 3 s ago" instead of 41 stack traces. Deliberately
// not aiming for language completeness: a few dumb patterns cover JS/TS,
// Python, Go, Rust and generic `Error:` logging; everything else still shows
// up via `logs --grep`.
package errscan

import (
	"cmp"
	"regexp"
	"slices"
	"strings"

	"github.com/kondaurovDev/procdeck/internal/lines"
)

// Group is one deduplicated error.
type Group struct {
	Proc string `json:"proc"`
	// Signature is the normalized message line — the dedup key.
	Signature string `json:"signature"`
	Count     int    `json:"count"`
	FirstTS   int64  `json:"firstTs"`
	LastTS    int64  `json:"lastTs"`
	// Sample is the last occurrence's lines, capped.
	Sample []string `json:"sample"`
}

// starts are lines that begin an error block.
var starts = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(unhandled|uncaught)\b`),
	// No leading \b: "TypeError" / "HTTPException" are single words.
	regexp.MustCompile(`(?i)(error|exception)s?\b`),
	regexp.MustCompile(`(?i)\b(panic|fatal|traceback)\b`),
	regexp.MustCompile(`(?i)\bfail(ed|ure)?\b`),
	regexp.MustCompile(`(?i)\b(econnrefused|eaddrinuse|enoent|etimedout|epipe)\b`),
	regexp.MustCompile(`(?i)\bsegmentation fault\b`),
	regexp.MustCompile(`(?i)\bassertion\b.*\bfailed\b`),
}

// negated are error-ish starts that are actually good news.
var negated = regexp.MustCompile(`(?i)\b(0|no|zero|without)\s+(errors?|failures?|warnings?)\b|✓|\bpassed\b`)

// continuations are lines that continue a block: stack frames and relatives.
var continuations = []*regexp.Regexp{
	regexp.MustCompile(`^\s+at\s.+`),              // JS/TS
	regexp.MustCompile(`^\s+File ".+", line \d+`), // Python
	regexp.MustCompile(`^\s+from .+:\d+`),         // Ruby
	regexp.MustCompile(`^\s*goroutine \d+`),       // Go
	regexp.MustCompile(`^\s+\S+\.(go|rs|c|cc|cpp|java|kt|scala|rb|ex|exs):\d+`),
	regexp.MustCompile(`(?i)^\s*caused by:?`),
	regexp.MustCompile(`(?i)^\s*(inner exception|--- end of|\.\.\. \d+ more)`),
	regexp.MustCompile(`^\s{4,}\S`), // deeply indented detail under an error line
}

// header is a traceback header: it promises frames on the following lines
// (Python), with the actual message after them.
var header = regexp.MustCompile(`(?i)^traceback \(most recent call last\)`)

const maxSample = 40

func isStart(text string) bool {
	if negated.MatchString(text) {
		return false
	}
	return slices.ContainsFunc(starts, func(re *regexp.Regexp) bool { return re.MatchString(text) })
}

func isContinuation(text string) bool {
	return slices.ContainsFunc(continuations, func(re *regexp.Regexp) bool { return re.MatchString(text) })
}

var (
	hexLiteral = regexp.MustCompile(`0x[0-9a-f]+`)
	hexRun     = regexp.MustCompile(`[0-9a-f]{8,}`)
	number     = regexp.MustCompile(`\d+(\.\d+)?`)
)

// Signature is the dedup key: the block's message line with everything
// volatile — counters, ports, ids, hashes, timings — collapsed, so
// "EADDRINUSE :3000" at 10:01 and 10:07 are one error, not two.
func Signature(text string) string {
	s := strings.ToLower(text)
	s = hexLiteral.ReplaceAllString(s, "#")
	s = hexRun.ReplaceAllString(s, "#")
	s = number.ReplaceAllString(s, "#")
	return strings.Join(strings.Fields(s), " ")
}

// Extract scans lines (per proc — blocks never span procs) into deduped error
// groups, most recent last occurrence first.
func Extract(all []lines.DeckLine) []Group {
	var procs []string
	byProc := map[string][]lines.DeckLine{}
	for _, line := range all {
		if _, seen := byProc[line.Proc]; !seen {
			procs = append(procs, line.Proc)
		}
		byProc[line.Proc] = append(byProc[line.Proc], line)
	}

	type key struct{ proc, signature string }
	index := map[key]int{}
	groups := []Group{}
	for _, proc := range procs {
		procLines := byProc[proc]
		for i := 0; i < len(procLines); {
			line := procLines[i]
			if line.Text == "" || !isStart(line.Text) {
				i++
				continue
			}

			// Collect the block: the start line, then frames/continuations. A
			// Python-style header also swallows the message line that follows
			// its frames.
			block := []string{line.Text}
			cursor := i + 1
			message, haveMessage := line.Text, !header.MatchString(line.Text)
			for cursor < len(procLines) && len(block) < maxSample {
				next := procLines[cursor].Text
				if isContinuation(next) {
					block = append(block, next)
					cursor++
					continue
				}
				if !haveMessage && next != "" {
					// The line after a traceback's frames is the actual error.
					message, haveMessage = next, true
					block = append(block, next)
					cursor++
				}
				break
			}

			k := key{proc, Signature(message)}
			if at, ok := index[k]; ok {
				g := &groups[at]
				g.Count++
				g.LastTS = line.TS
				g.Sample = block
			} else {
				index[k] = len(groups)
				groups = append(groups, Group{
					Proc: proc, Signature: k.signature, Count: 1, FirstTS: line.TS, LastTS: line.TS, Sample: block,
				})
			}
			i = cursor
		}
	}

	slices.SortStableFunc(groups, func(a, b Group) int { return cmp.Compare(b.LastTS, a.LastTS) })
	return groups
}
