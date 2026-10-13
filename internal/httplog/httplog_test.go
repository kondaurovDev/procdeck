package httplog

import (
	"encoding/json"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestBodyTap(t *testing.T) {
	tap := NewBodyTap(true)
	tap.Write([]byte("hello "))
	tap.Write([]byte("world"))
	if tap.Body() != "hello world" || tap.Bytes != 11 {
		t.Errorf("text tap = %q / %d", tap.Body(), tap.Bytes)
	}

	binary := NewBodyTap(false)
	binary.Write(make([]byte, 1000))
	if binary.Body() != "" || binary.Bytes != 1000 {
		t.Errorf("binary bodies are a size, not bytes: %q / %d", binary.Body(), binary.Bytes)
	}

	long := NewBodyTap(true)
	long.Write([]byte(strings.Repeat("x", BodyLimit+500)))
	if len(long.Body()) != BodyLimit || long.Bytes != BodyLimit+500 {
		t.Errorf("truncation: kept %d, counted %d", len(long.Body()), long.Bytes)
	}
}

func TestBodyTapCutRune(t *testing.T) {
	tap := NewBodyTap(true)
	tap.Write([]byte(strings.Repeat("x", BodyLimit-1) + "é"))
	if body := tap.Body(); !strings.HasSuffix(body, "�") {
		t.Errorf("a cut rune must end in U+FFFD, got %q", body[len(body)-4:])
	}
}

func TestIsTextType(t *testing.T) {
	for _, ct := range []string{"application/json; charset=utf-8", "text/html", "application/vnd.api+json", "application/x-www-form-urlencoded"} {
		if !IsTextType(ct) {
			t.Errorf("IsTextType(%q) = false", ct)
		}
	}
	for _, ct := range []string{"image/png", "application/octet-stream", ""} {
		if IsTextType(ct) {
			t.Errorf("IsTextType(%q) = true", ct)
		}
	}
}

func TestRedactHeaders(t *testing.T) {
	redacted := RedactHeaders(http.Header{
		"Authorization": {"Bearer secret"},
		"Cookie":        {"sid=1"},
		"Set-Cookie":    {"a=1", "b=2"},
		"X-Api-Key":     {"k"},
		"Content-Type":  {"application/json"},
		"Accept":        {"a", "b"},
	})
	want := map[string]string{
		"authorization": "[redacted]",
		"cookie":        "[redacted]",
		"set-cookie":    "[redacted]",
		"x-api-key":     "[redacted]",
		"content-type":  "application/json",
		"accept":        "a, b",
	}
	if !reflect.DeepEqual(redacted, want) {
		t.Errorf("redacted = %v", redacted)
	}
}

func TestStatusMatcher(t *testing.T) {
	check := func(raw string, status int, want bool) {
		t.Helper()
		match, ok := StatusMatcher(raw)
		if !ok {
			t.Fatalf("StatusMatcher(%q) did not parse", raw)
		}
		if match(status) != want {
			t.Errorf("StatusMatcher(%q)(%d) = %v", raw, status, !want)
		}
	}
	check("5xx", 503, true)
	check("5XX", 503, true)
	check("5xx", 404, false)
	check("422", 422, true)
	check("422", 400, false)
	check("error", 404, true)
	check("error", 0, true)
	check("error", 200, false)
	if _, ok := StatusMatcher("nope"); ok {
		t.Error(`StatusMatcher("nope") parsed`)
	}
}

func capture(over func(*Capture)) Capture {
	c := Capture{Method: "GET", Path: "/", Status: 200, DurationMs: 1}
	if over != nil {
		over(&c)
	}
	return c
}

func TestBufferSeqSurvivesEviction(t *testing.T) {
	var b Buffer
	fat := strings.Repeat("x", 16*1024)
	for i := range 100 {
		b.Record(capture(func(c *Capture) { c.TS = int64(i); c.ResBody = fat }))
	}
	kept := b.Slice(Window{})
	if len(kept) >= 100 || kept[len(kept)-1].Seq != 99 || b.NextSeq() != 100 {
		t.Fatalf("kept %d, last seq %d, next %d", len(kept), kept[len(kept)-1].Seq, b.NextSeq())
	}
}

func TestBufferSlice(t *testing.T) {
	var b Buffer
	for _, ts := range []int64{10, 20, 30} {
		b.Record(capture(func(c *Capture) { c.TS = ts }))
	}
	if n := len(b.Slice(Window{SinceSeq: 1})); n != 2 {
		t.Errorf("by seq: %d", n)
	}
	if n := len(b.Slice(Window{SinceMs: 15, UntilMs: 25})); n != 1 {
		t.Errorf("by time: %d", n)
	}
}

func deck() map[string]*Buffer {
	api := &Buffer{}
	api.Record(capture(func(c *Capture) {
		c.TS, c.Path, c.ReqBody, c.ResBody = 100, "/users/42", "req", "res"
		c.ReqHeaders = map[string]string{"host": "x"}
	}))
	api.Record(capture(func(c *Capture) { c.TS, c.Method, c.Path, c.Status = 300, "POST", "/orders", 422 }))
	api.Record(Capture{Kind: KindWS, TS: 400, ConnID: 1, Dir: "in", Opcode: "text", Path: "/chat", Size: 2, Text: "hi"})
	web := &Buffer{}
	web.Record(capture(func(c *Capture) { c.TS, c.Path = 200, "/index.html" }))
	return map[string]*Buffer{"api": api, "web": web}
}

func paths(entries []Entry) []string {
	out := []string{}
	for _, e := range entries {
		out = append(out, e.Proc+":"+e.Path)
	}
	return out
}

func TestRunInterleavesAndStripsBodies(t *testing.T) {
	result, err := Run(deck(), Query{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"api:/users/42", "web:/index.html", "api:/orders", "api:/chat"}
	if got := paths(result.Exchanges); !slices.Equal(got, want) {
		t.Fatalf("exchanges = %q", got)
	}
	if result.NextSeq["api"] != 3 || result.NextSeq["web"] != 1 {
		t.Errorf("cursors = %v", result.NextSeq)
	}
	first := result.Exchanges[0]
	if first.ReqBody != "" || first.ReqHeaders != nil || result.Exchanges[3].Text != "" {
		t.Errorf("bodies leaked without Bodies: %+v", first)
	}

	withBodies, _ := Run(deck(), Query{Limit: 10, Bodies: true})
	if withBodies.Exchanges[0].ReqBody != "req" || withBodies.Exchanges[0].ReqHeaders["host"] != "x" {
		t.Errorf("bodies missing with Bodies: %+v", withBodies.Exchanges[0])
	}
}

func TestRunFilters(t *testing.T) {
	if result, _ := Run(deck(), Query{Limit: 10, Status: "4xx"}); len(result.Exchanges) != 1 {
		t.Errorf("status 4xx: %q", paths(result.Exchanges))
	}
	if result, _ := Run(deck(), Query{Limit: 10, Path: "^/USERS"}); len(result.Exchanges) != 1 {
		t.Errorf("path: %q", paths(result.Exchanges))
	}
	if result, _ := Run(deck(), Query{Limit: 10, Kind: KindWS}); !slices.Equal(paths(result.Exchanges), []string{"api:/chat"}) {
		t.Errorf("kind ws: %q", paths(result.Exchanges))
	}
	limited, _ := Run(deck(), Query{Limit: 1})
	if !slices.Equal(paths(limited.Exchanges), []string{"api:/chat"}) || limited.Omitted != 3 {
		t.Errorf("limit: %q omitted %d", paths(limited.Exchanges), limited.Omitted)
	}
}

func TestRunErrors(t *testing.T) {
	if _, err := Run(deck(), Query{Limit: 1, Procs: []string{"nope"}}); err == nil || err.Error() != `unknown proc "nope"` {
		t.Errorf("unknown proc: %v", err)
	}
	if _, err := Run(deck(), Query{Limit: 1, Status: "watman"}); err == nil || !strings.Contains(err.Error(), "bad status filter") {
		t.Errorf("bad status: %v", err)
	}
	if _, err := Run(deck(), Query{Limit: 1, Path: "("}); err == nil {
		t.Error("bad path: no error")
	}
}

func TestEntryJSON(t *testing.T) {
	result, _ := Run(deck(), Query{Limit: 10})
	data, err := json.Marshal(result.Exchanges)
	if err != nil {
		t.Fatal(err)
	}
	var raw []map[string]any
	json.Unmarshal(data, &raw)
	if _, ok := raw[0]["kind"]; ok {
		t.Errorf("an HTTP exchange has no kind key: %s", data)
	}
	if raw[3]["kind"] != "ws" || raw[3]["dir"] != "in" {
		t.Errorf("ws entry = %v", raw[3])
	}
	if _, ok := raw[0]["status"]; !ok {
		t.Error("status must always be present on HTTP entries")
	}

	var back []Entry
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back, result.Exchanges) {
		t.Errorf("round trip:\n got %+v\nwant %+v", back, result.Exchanges)
	}
}

func TestNormalizePath(t *testing.T) {
	cases := map[string]string{
		"/users/42/orders/7?page=2":                   "/users/:id/orders/:id",
		"/users/0d9af438-3bc2-4a51-bc26-e15c1e17d0d0": "/users/:id",
		"/blobs/deadbeef1234":                         "/blobs/:id",
		"/health":                                     "/health",
	}
	for in, want := range cases {
		if got := NormalizePath(in); got != want {
			t.Errorf("NormalizePath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDigest(t *testing.T) {
	entry := func(proc string, ts int64, path string, status int) Entry {
		return Entry{Capture: capture(func(c *Capture) { c.TS, c.Path, c.Status = ts, path, status }), Proc: proc}
	}
	groups := Digest([]Entry{
		entry("api", 1, "/users/1", 500),
		entry("api", 9, "/users/2", 500),
		entry("api", 5, "/ok", 200),
		entry("web", 20, "/dead", 0),
	})
	want := []DigestGroup{
		{Proc: "web", Method: "GET", Path: "/dead", Status: 0, Count: 1, FirstTS: 20, LastTS: 20},
		{Proc: "api", Method: "GET", Path: "/users/:id", Status: 500, Count: 2, FirstTS: 1, LastTS: 9},
	}
	if !reflect.DeepEqual(groups, want) {
		t.Errorf("digest = %+v", groups)
	}
}
