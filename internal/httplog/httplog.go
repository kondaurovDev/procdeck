// Package httplog is the HTTP exchange log — the traffic twin of the line
// buffers (see docs/design/http-observability.md). One ring per proc,
// byte-bounded and seq-cursored like package lines, holding what flowed
// through procdeck's two interception points: the `*.localhost` reverse proxy
// and the per-proc observer that fronts each assigned port. Pure data
// structures and queries here; the proxying itself lives in package interpose.
package httplog

import (
	"cmp"
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Kind tells an HTTP exchange from a WebSocket message in the same ring.
type Kind string

const (
	KindHTTP Kind = "http"
	KindWS   Kind = "ws"
)

// Capture is one recorded exchange or message, before proc/seq attribution.
// The fields after Kind/TS/Path/ConnID belong to one kind or the other; the
// JSON form carries only the fields of its own kind.
type Capture struct {
	Kind Kind
	// TS is the epoch ms when the request reached the proxy (HTTP) or when the
	// message completed (WS).
	TS int64
	// Path is the path + query as the client sent it; for WS, the upgrade
	// request's path — so `--path` filters apply to messages too.
	Path string
	// ConnID ties a 101 upgrade exchange to its messages; 0 means none.
	ConnID int

	Method string
	// Status 0 means the upstream never answered (connection refused).
	Status     int
	DurationMs int64
	// ReqBytes and ResBytes are full body sizes — the bodies may be truncated.
	ReqBytes int64
	ResBytes int64
	// ReqBody and ResBody are text bodies truncated to BodyLimit; empty for
	// binary or empty bodies.
	ReqBody string
	ResBody string
	// ReqHeaders and ResHeaders are redacted at capture — never stored raw.
	ReqHeaders map[string]string
	ResHeaders map[string]string

	// Dir is "in" (client → proc) or "out" (proc → client).
	Dir string
	// Opcode is "text" or "binary".
	Opcode string
	// Size is the full message size; Text may be truncated.
	Size int64
	Text string
}

// IsWS reports whether the capture is a WebSocket message.
func (c *Capture) IsWS() bool { return c.Kind == KindWS }

// Entry is a capture in a proc's ring: attributed and cursor-addressable.
type Entry struct {
	Capture
	Seq  int
	Proc string
}

// httpView and wsView are the wire shapes: an HTTP exchange has no `kind`
// key, a WebSocket message has `kind: "ws"`.
type httpView struct {
	TS         int64             `json:"ts"`
	Method     string            `json:"method"`
	Path       string            `json:"path"`
	Status     int               `json:"status"`
	DurationMs int64             `json:"durationMs"`
	ReqBytes   int64             `json:"reqBytes"`
	ResBytes   int64             `json:"resBytes"`
	ReqBody    string            `json:"reqBody,omitempty"`
	ResBody    string            `json:"resBody,omitempty"`
	ReqHeaders map[string]string `json:"reqHeaders,omitempty"`
	ResHeaders map[string]string `json:"resHeaders,omitempty"`
	ConnID     int               `json:"connId,omitempty"`
	Seq        int               `json:"seq"`
	Proc       string            `json:"proc"`
}

type wsView struct {
	Kind   Kind   `json:"kind"`
	TS     int64  `json:"ts"`
	ConnID int    `json:"connId"`
	Dir    string `json:"dir"`
	Opcode string `json:"opcode"`
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	Text   string `json:"text,omitempty"`
	Seq    int    `json:"seq"`
	Proc   string `json:"proc"`
}

func (e Entry) MarshalJSON() ([]byte, error) {
	if e.IsWS() {
		return json.Marshal(wsView{
			Kind: KindWS, TS: e.TS, ConnID: e.ConnID, Dir: e.Dir, Opcode: e.Opcode,
			Path: e.Path, Size: e.Size, Text: e.Text, Seq: e.Seq, Proc: e.Proc,
		})
	}
	return json.Marshal(httpView{
		TS: e.TS, Method: e.Method, Path: e.Path, Status: e.Status, DurationMs: e.DurationMs,
		ReqBytes: e.ReqBytes, ResBytes: e.ResBytes, ReqBody: e.ReqBody, ResBody: e.ResBody,
		ReqHeaders: e.ReqHeaders, ResHeaders: e.ResHeaders, ConnID: e.ConnID, Seq: e.Seq, Proc: e.Proc,
	})
}

func (e *Entry) UnmarshalJSON(data []byte) error {
	var probe struct {
		Kind Kind `json:"kind"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return err
	}
	if probe.Kind == KindWS {
		var v wsView
		if err := json.Unmarshal(data, &v); err != nil {
			return err
		}
		*e = Entry{
			Capture: Capture{Kind: KindWS, TS: v.TS, ConnID: v.ConnID, Dir: v.Dir, Opcode: v.Opcode, Path: v.Path, Size: v.Size, Text: v.Text},
			Seq:     v.Seq, Proc: v.Proc,
		}
		return nil
	}
	var v httpView
	if err := json.Unmarshal(data, &v); err != nil {
		return err
	}
	*e = Entry{
		Capture: Capture{
			Kind: KindHTTP, TS: v.TS, Method: v.Method, Path: v.Path, Status: v.Status, DurationMs: v.DurationMs,
			ReqBytes: v.ReqBytes, ResBytes: v.ResBytes, ReqBody: v.ReqBody, ResBody: v.ResBody,
			ReqHeaders: v.ReqHeaders, ResHeaders: v.ResHeaders, ConnID: v.ConnID,
		},
		Seq: v.Seq, Proc: v.Proc,
	}
	return nil
}

// BodyLimit is the per-body capture cap; the full size is always recorded.
const BodyLimit = 16 * 1024

// bufferBytes is the budget per proc's ring — bodies make exchanges fat, so
// twice the line buffers'.
const bufferBytes = 512 * 1024

// BodyTap accumulates a body stream as an io.Writer: it counts every byte and
// keeps at most BodyLimit of them, and only when the content type said "text"
// — binary bodies are a fact and a size, never bytes.
type BodyTap struct {
	Bytes int64
	text  bool
	kept  []byte
}

func NewBodyTap(text bool) *BodyTap { return &BodyTap{text: text} }

func (t *BodyTap) Write(p []byte) (int, error) {
	t.Bytes += int64(len(p))
	if t.text && len(t.kept) < BodyLimit {
		t.kept = append(t.kept, p[:min(len(p), BodyLimit-len(t.kept))]...)
	}
	return len(p), nil
}

// Body is the kept text; empty for binary or empty bodies. A truncation that
// cut a UTF-8 sequence ends in U+FFFD rather than broken bytes.
func (t *BodyTap) Body() string {
	if !t.text || t.Bytes == 0 {
		return ""
	}
	if utf8.Valid(t.kept) {
		return string(t.kept)
	}
	return strings.ToValidUTF8(string(t.kept), "�")
}

// IsTextType reports whether bodies of this content type are worth keeping.
func IsTextType(contentType string) bool {
	bare, _, _ := strings.Cut(contentType, ";")
	bare = strings.ToLower(strings.TrimSpace(bare))
	switch {
	case bare == "":
		return false
	case strings.HasPrefix(bare, "text/"),
		strings.HasSuffix(bare, "+json"),
		strings.HasSuffix(bare, "+xml"):
		return true
	}
	switch bare {
	case "application/json", "application/x-www-form-urlencoded", "application/xml",
		"application/graphql", "application/javascript":
		return true
	}
	return false
}

// sensitive header names never enter the ring with their values.
var sensitive = map[string]bool{
	"authorization":       true,
	"proxy-authorization": true,
	"cookie":              true,
	"set-cookie":          true,
	"x-api-key":           true,
	"x-auth-token":        true,
}

// RedactHeaders lowercases names, joins repeated values and replaces
// sensitive values — applied at capture time.
func RedactHeaders(headers http.Header) map[string]string {
	out := make(map[string]string, len(headers))
	for name, values := range headers {
		key := strings.ToLower(name)
		if sensitive[key] {
			out[key] = "[redacted]"
		} else {
			out[key] = strings.Join(values, ", ")
		}
	}
	return out
}

// Buffer is one proc's byte-bounded, seq-cursored ring of captures. Not safe
// for concurrent use; the supervisor guards it.
type Buffer struct {
	items []Entry
	bytes int
	seq   int
}

// NextSeq is the seq the next recorded capture will get.
func (b *Buffer) NextSeq() int { return b.seq }

func (b *Buffer) Record(c Capture) {
	if c.Kind == "" {
		c.Kind = KindHTTP
	}
	item := Entry{Capture: c, Seq: b.seq}
	b.seq++
	b.items = append(b.items, item)
	b.bytes += cost(&item.Capture)
	for b.bytes > bufferBytes && len(b.items) > 1 {
		b.bytes -= cost(&b.items[0].Capture)
		b.items = b.items[1:]
	}
}

// Window bounds a slice of a ring. Zero values mean "unbounded".
type Window struct {
	SinceSeq int
	SinceMs  int64
	UntilMs  int64
}

// Slice returns the captures within the window, oldest first.
func (b *Buffer) Slice(w Window) []Entry {
	var out []Entry
	for _, item := range b.items {
		if item.Seq >= w.SinceSeq && item.TS >= w.SinceMs && (w.UntilMs == 0 || item.TS <= w.UntilMs) {
			out = append(out, item)
		}
	}
	return out
}

// cost approximates one capture's memory footprint for the ring's budget.
func cost(c *Capture) int {
	if c.IsWS() {
		return 64 + len(c.Path) + len(c.Text)
	}
	return 64 + len(c.Path) + len(c.ReqBody) + len(c.ResBody) + headersCost(c.ReqHeaders) + headersCost(c.ResHeaders)
}

func headersCost(headers map[string]string) int {
	n := 0
	for name, value := range headers {
		n += len(name) + len(value) + 6
	}
	return n
}

var (
	statusClass = regexp.MustCompile(`^(?i)([1-5])xx$`)
	statusCode  = regexp.MustCompile(`^\d{3}$`)
)

// StatusMatcher turns "5xx" / "404" / "error" into a status predicate; false
// when the filter does not parse.
func StatusMatcher(raw string) (func(status int) bool, bool) {
	if m := statusClass.FindStringSubmatch(raw); m != nil {
		base := int(m[1][0]-'0') * 100
		return func(status int) bool { return status >= base && status < base+100 }, true
	}
	if statusCode.MatchString(raw) {
		code, _ := strconv.Atoi(raw)
		return func(status int) bool { return status == code }, true
	}
	if raw == "error" || raw == "errors" {
		return func(status int) bool { return status >= 400 || status == 0 }, true
	}
	return nil, false
}

// Query selects captures across many procs.
type Query struct {
	// Procs to include; nil means every proc.
	Procs []string
	// SinceSeq narrows per proc: only captures with seq >= SinceSeq[proc].
	SinceSeq map[string]int
	SinceMs  int64
	UntilMs  int64
	// Status is "5xx" (class), "422" (exact) or "error" (>= 400 and
	// never-answered). WebSocket messages have no status, so any status filter
	// excludes them.
	Status string
	// Path is a regexp matched against the path, case-insensitively.
	Path string
	// Kind keeps only one kind of capture; empty keeps both, interleaved.
	Kind Kind
	// Bodies includes bodies and headers (off = metadata only).
	Bodies bool
	// Limit caps the result to the tail of the matches.
	Limit int
}

// Result is a query's answer.
type Result struct {
	Exchanges []Entry `json:"exchanges"`
	// NextSeq per requested proc: the seq the next capture will get.
	NextSeq map[string]int `json:"nextSeq"`
	// Omitted counts the matching captures dropped by Limit.
	Omitted int `json:"omitted"`
}

// Run filters many procs' rings, interleaves the matches by time and keeps
// the tail. An unknown proc, a bad path pattern or a bad status filter is an
// error — callers turn it into a 400 or a CLI failure.
func Run(buffers map[string]*Buffer, q Query) (Result, error) {
	var pathPattern *regexp.Regexp
	if q.Path != "" {
		compiled, err := regexp.Compile("(?i)" + q.Path)
		if err != nil {
			return Result{}, fmt.Errorf("bad path pattern: %w", err)
		}
		pathPattern = compiled
	}
	var matchStatus func(int) bool
	if q.Status != "" {
		matcher, ok := StatusMatcher(q.Status)
		if !ok {
			return Result{}, fmt.Errorf("bad status filter %q — try 5xx, 422 or error", q.Status)
		}
		matchStatus = matcher
	}

	ids := q.Procs
	if ids == nil {
		ids = slices.Sorted(maps.Keys(buffers))
	}
	matched := []Entry{}
	next := make(map[string]int, len(ids))
	for _, id := range ids {
		buffer, ok := buffers[id]
		if !ok {
			return Result{}, fmt.Errorf("unknown proc %q", id)
		}
		next[id] = buffer.NextSeq()
		for _, item := range buffer.Slice(Window{SinceSeq: q.SinceSeq[id], SinceMs: q.SinceMs, UntilMs: q.UntilMs}) {
			if q.Kind != "" && item.Kind != q.Kind {
				continue
			}
			if pathPattern != nil && !pathPattern.MatchString(item.Path) {
				continue
			}
			// A status filter names response codes — ws messages have none.
			if matchStatus != nil && (item.IsWS() || !matchStatus(item.Status)) {
				continue
			}
			item.Proc = id
			if !q.Bodies {
				item.ReqBody, item.ResBody, item.ReqHeaders, item.ResHeaders, item.Text = "", "", nil, nil, ""
			}
			matched = append(matched, item)
		}
	}

	slices.SortFunc(matched, func(a, b Entry) int {
		return cmp.Or(cmp.Compare(a.TS, b.TS), strings.Compare(a.Proc, b.Proc), cmp.Compare(a.Seq, b.Seq))
	})
	omitted := max(0, len(matched)-q.Limit)
	return Result{Exchanges: matched[omitted:], NextSeq: next, Omitted: omitted}, nil
}

var (
	numericSegment = regexp.MustCompile(`^\d+$`)
	uuidSegment    = regexp.MustCompile(`^(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	hexSegment     = regexp.MustCompile(`^(?i)[0-9a-f]{8,}$`)
)

// NormalizePath collapses path params so exchanges group by route: numeric,
// uuid and hex-ish segments become `:id` — the same spirit as error
// signatures. The query string is dropped entirely.
func NormalizePath(path string) string {
	bare, _, _ := strings.Cut(path, "?")
	segments := strings.Split(bare, "/")
	for i, segment := range segments {
		if numericSegment.MatchString(segment) || uuidSegment.MatchString(segment) || hexSegment.MatchString(segment) {
			segments[i] = ":id"
		}
	}
	return strings.Join(segments, "/")
}

// DigestGroup is one failing route.
type DigestGroup struct {
	Proc   string `json:"proc"`
	Method string `json:"method"`
	// Path is the normalized route — `/users/:id`, not `/users/42`.
	Path    string `json:"path"`
	Status  int    `json:"status"`
	Count   int    `json:"count"`
	FirstTS int64  `json:"firstTs"`
	LastTS  int64  `json:"lastTs"`
}

// Digest is the `errors` analog for traffic: 4xx/5xx (and never-answered)
// exchanges grouped by proc + method + normalized route + status, most recent
// first.
func Digest(entries []Entry) []DigestGroup {
	type key struct {
		proc, method, route string
		status              int
	}
	index := map[key]int{}
	groups := []DigestGroup{}
	for _, e := range entries {
		if e.IsWS() || (e.Status < 400 && e.Status != 0) {
			continue
		}
		k := key{e.Proc, e.Method, NormalizePath(e.Path), e.Status}
		if i, ok := index[k]; ok {
			g := &groups[i]
			g.Count++
			g.FirstTS = min(g.FirstTS, e.TS)
			g.LastTS = max(g.LastTS, e.TS)
			continue
		}
		index[k] = len(groups)
		groups = append(groups, DigestGroup{
			Proc: e.Proc, Method: e.Method, Path: k.route, Status: e.Status, Count: 1, FirstTS: e.TS, LastTS: e.TS,
		})
	}
	slices.SortStableFunc(groups, func(a, b DigestGroup) int { return cmp.Compare(b.LastTS, a.LastTS) })
	return groups
}
