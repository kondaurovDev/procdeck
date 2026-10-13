package errscan

import (
	"slices"
	"strings"
	"testing"

	"github.com/kondaurovDev/procdeck/internal/lines"
)

func procLines(proc string, startTS int64, texts ...string) []lines.DeckLine {
	out := make([]lines.DeckLine, len(texts))
	for i, text := range texts {
		out[i] = lines.DeckLine{Line: lines.Line{Seq: i, TS: startTS + int64(i), Text: text}, Proc: proc}
	}
	return out
}

func TestSignatureCollapsesVolatileParts(t *testing.T) {
	pairs := [][2]string{
		{"Error: EADDRINUSE :3000", "error: EADDRINUSE :4000"},
		{"worker 0x1a2b3c died", "worker 0xffee11 died"},
		{"retry 12 failed", "retry 99  failed"},
	}
	for _, pair := range pairs {
		if Signature(pair[0]) != Signature(pair[1]) {
			t.Errorf("%q vs %q: %q != %q", pair[0], pair[1], Signature(pair[0]), Signature(pair[1]))
		}
	}
}

func TestJSStackTrace(t *testing.T) {
	groups := Extract(procLines("api", 0,
		"GET /users 200",
		"TypeError: Cannot read properties of undefined (reading 'id')",
		"    at handler (src/routes.ts:42:11)",
		"    at process.processTicksAndRejections (node:internal:95:5)",
		"GET /users 500",
	))
	if len(groups) != 1 || !strings.Contains(groups[0].Sample[0], "TypeError") || len(groups[0].Sample) != 3 {
		t.Fatalf("groups = %+v", groups)
	}
}

func TestPythonTraceback(t *testing.T) {
	groups := Extract(procLines("worker", 0,
		"Traceback (most recent call last):",
		`  File "app.py", line 10, in <module>`,
		"    main()",
		"ValueError: bad input 42",
	))
	if len(groups) != 1 || !strings.Contains(groups[0].Signature, "valueerror") {
		t.Fatalf("groups = %+v", groups)
	}
}

func TestDedupesRepeats(t *testing.T) {
	groups := Extract(slices.Concat(
		procLines("api", 100, "Error: connect ECONNREFUSED 127.0.0.1:5432"),
		procLines("api", 900, "Error: connect ECONNREFUSED 127.0.0.1:5432"),
	))
	if len(groups) != 1 || groups[0].Count != 2 || groups[0].FirstTS != 100 || groups[0].LastTS != 900 {
		t.Fatalf("groups = %+v", groups)
	}
}

func TestProcsStaySeparate(t *testing.T) {
	groups := Extract(slices.Concat(procLines("api", 1, "Error: boom"), procLines("web", 2, "Error: boom")))
	if len(groups) != 2 {
		t.Fatalf("groups = %+v", groups)
	}
}

func TestGoodNewsIsNotAnError(t *testing.T) {
	if groups := Extract(procLines("web", 0, "✓ built in 1.2s", "0 errors, 0 warnings", "test suite passed")); len(groups) != 0 {
		t.Fatalf("groups = %+v", groups)
	}
}

func TestMostRecentFirst(t *testing.T) {
	groups := Extract(slices.Concat(procLines("api", 10, "Error: old problem"), procLines("api", 500, "Error: new problem")))
	got := []string{groups[0].Signature, groups[1].Signature}
	if want := []string{"error: new problem", "error: old problem"}; !slices.Equal(got, want) {
		t.Fatalf("order = %q", got)
	}
}
