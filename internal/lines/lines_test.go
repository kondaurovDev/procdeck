package lines

import (
	"fmt"
	"slices"
	"strings"
	"testing"
)

func TestStripANSI(t *testing.T) {
	cases := map[string]string{
		"\x1b[31mred\x1b[0m plain":                 "red plain",
		"\x1b[2K\x1b[1Gprompt":                     "prompt",
		"\x1b]0;window title\x07after":             "after",
		"\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\": "link",
		"a\x1b(Bb": "ab",
		// Newlines, tabs and carriage returns survive.
		"a\r\nb\tc": "a\r\nb\tc",
		// Stray C0 controls do not.
		"a\x08b\x00c": "abc",
	}
	for in, want := range cases {
		if got := StripANSI(in); got != want {
			t.Errorf("StripANSI(%q) = %q, want %q", in, got, want)
		}
	}
}

func texts(lines []Line) []string {
	out := []string{}
	for _, line := range lines {
		out = append(out, line.Text)
	}
	return out
}

func TestBufferSplitsAcrossChunks(t *testing.T) {
	var b Buffer
	b.Push("hel", 1)
	b.Push("lo\r\nwor", 2)
	b.Push("ld\n", 3)
	got := b.Slice(Window{})
	if want := []string{"hello", "world"}; !slices.Equal(texts(got), want) {
		t.Fatalf("texts = %q, want %q", texts(got), want)
	}
	// A line is stamped when it completes.
	if got[0].TS != 2 || got[1].TS != 3 || got[0].Seq != 0 || got[1].Seq != 1 {
		t.Fatalf("stamps = %+v", got)
	}
}

func TestBufferCRLFSplitAcrossChunks(t *testing.T) {
	var b Buffer
	b.Push("first\r", 1)
	b.Push("\nsecond\r", 2)
	b.Push("\n", 3)
	if want := []string{"first", "second"}; !slices.Equal(texts(b.Slice(Window{})), want) {
		t.Fatalf("texts = %q, want %q", texts(b.Slice(Window{})), want)
	}
}

func TestBufferLoneCROverwrites(t *testing.T) {
	var b Buffer
	b.Push("done 10%\rdone 50%\rdone 100%\r\n", 1)
	if want := []string{"done 100%"}; !slices.Equal(texts(b.Slice(Window{})), want) {
		t.Fatalf("texts = %q, want %q", texts(b.Slice(Window{})), want)
	}
	// A trailing \r followed by fresh text is still an overwrite.
	b.Push("tick 1\r", 2)
	b.Push("tick 2\n", 3)
	if got := texts(b.Slice(Window{SinceSeq: 1})); !slices.Equal(got, []string{"tick 2"}) {
		t.Fatalf("texts = %q", got)
	}
}

func TestBufferEvictsPastBudget(t *testing.T) {
	var b Buffer
	line := strings.Repeat("x", 127)
	for i := range 4096 {
		b.Push(fmt.Sprintf("%s%d\n", line, i), int64(i))
	}
	kept := b.Slice(Window{})
	if len(kept) >= 4096 {
		t.Fatalf("kept %d lines, want eviction", len(kept))
	}
	last := kept[len(kept)-1]
	// seq keeps counting across evictions — a stable cursor.
	if !strings.HasSuffix(last.Text, "4095") || last.Seq != 4095 {
		t.Fatalf("last = %+v", last)
	}
}

func TestBufferFlushesOverlongLine(t *testing.T) {
	var b Buffer
	b.Push(strings.Repeat("y", 10_000), 1)
	if len(b.Slice(Window{})) == 0 {
		t.Fatal("an over-long partial was not flushed")
	}
}

func TestBufferSliceFilters(t *testing.T) {
	var b Buffer
	b.Push("a\n", 10)
	b.Push("b\n", 20)
	b.Push("c\n", 30)
	if got := texts(b.Slice(Window{SinceSeq: 1})); !slices.Equal(got, []string{"b", "c"}) {
		t.Errorf("by seq = %q", got)
	}
	if got := texts(b.Slice(Window{SinceMs: 25})); !slices.Equal(got, []string{"c"}) {
		t.Errorf("by time = %q", got)
	}
}

func deck() map[string]*Buffer {
	api := &Buffer{}
	api.Push("listening on :3000\n", 100)
	api.Push("GET /users 200\n", 300)
	web := &Buffer{}
	web.Push("vite ready\n", 200)
	return map[string]*Buffer{"api": api, "web": web}
}

func deckTexts(lines []DeckLine) []string {
	out := []string{}
	for _, line := range lines {
		out = append(out, line.Proc+":"+line.Text)
	}
	return out
}

func TestRunInterleavesAndReportsCursors(t *testing.T) {
	result, err := Run(deck(), Query{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"api:listening on :3000", "web:vite ready", "api:GET /users 200"}
	if got := deckTexts(result.Lines); !slices.Equal(got, want) {
		t.Fatalf("lines = %q, want %q", got, want)
	}
	if result.NextSeq["api"] != 2 || result.NextSeq["web"] != 1 || result.Omitted != 0 {
		t.Fatalf("cursors = %v, omitted = %d", result.NextSeq, result.Omitted)
	}
}

func TestRunLimitKeepsTail(t *testing.T) {
	result, _ := Run(deck(), Query{Limit: 1})
	if got := deckTexts(result.Lines); !slices.Equal(got, []string{"api:GET /users 200"}) || result.Omitted != 2 {
		t.Fatalf("lines = %q, omitted = %d", got, result.Omitted)
	}
}

func TestRunTimeWindow(t *testing.T) {
	result, _ := Run(deck(), Query{Limit: 10, SinceMs: 150, UntilMs: 250})
	if got := deckTexts(result.Lines); !slices.Equal(got, []string{"web:vite ready"}) {
		t.Fatalf("lines = %q", got)
	}
}

func TestRunGrepAndNarrowing(t *testing.T) {
	result, _ := Run(deck(), Query{Limit: 10, Grep: "LISTENING"})
	if len(result.Lines) != 1 {
		t.Errorf("grep matched %d lines, want 1 (case-insensitive)", len(result.Lines))
	}
	result, _ = Run(deck(), Query{Limit: 10, Procs: []string{"api"}, SinceSeq: map[string]int{"api": 1}})
	if got := deckTexts(result.Lines); !slices.Equal(got, []string{"api:GET /users 200"}) {
		t.Errorf("narrowed = %q", got)
	}
}

func TestRunErrors(t *testing.T) {
	if _, err := Run(deck(), Query{Limit: 10, Procs: []string{"nope"}}); err == nil || err.Error() != `unknown proc "nope"` {
		t.Errorf("unknown proc: err = %v", err)
	}
	if _, err := Run(deck(), Query{Limit: 10, Grep: "("}); err == nil {
		t.Error("bad grep: no error")
	}
}
