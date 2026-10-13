// Package server is the deck's HTTP face: the JSON API under
// /__procdeck/api, the SSE event feed and the embedded UI.
package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/kondaurovDev/procdeck/internal/httplog"
	"github.com/kondaurovDev/procdeck/internal/interpose"
	"github.com/kondaurovDev/procdeck/internal/lines"
	"github.com/kondaurovDev/procdeck/internal/registry"
	"github.com/kondaurovDev/procdeck/internal/supervisor"
)

const (
	api       = "/__procdeck/api"
	heartbeat = 20 * time.Second

	defaultLogLines = 200
	maxLogLines     = 5000
	defaultHTTP     = 50
	maxHTTP         = 1000
)

// Deck is what the UI needs to know about the deck as a whole.
type Deck struct {
	Name string `json:"name"`
	// Root lets the UI tell "this deck" apart in the registry.
	Root    string `json:"root"`
	Port    int    `json:"port"`
	Version string `json:"version"`
}

// Hooks are the deck-wide actions the server only exposes over HTTP.
type Hooks struct {
	// Shutdown takes the whole deck down — the UI's Shutdown button.
	Shutdown func()
	// Instances lists every live deck on this machine.
	Instances func() []registry.Instance
}

type handler struct {
	sup   *supervisor.Supervisor
	deck  Deck
	hooks Hooks
	ui    fs.FS
}

// Handler routes `<id>.localhost` to the proc's port and serves the API
// and the UI for everything else.
func Handler(sup *supervisor.Supervisor, deck Deck, hooks Hooks, ui fs.FS) http.Handler {
	mux := apiHandler(sup, deck, hooks, ui)
	if sup == nil {
		return mux
	}
	// Known pane subdomains are proxied; plain localhost and unknown names
	// are the procdeck UI.
	ids := map[string]bool{}
	for _, id := range sup.IDs() {
		ids[id] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if id, ok := procHost(r.Host); ok && ids[id] {
			proxy(sup, id, w, r)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

// procHost reads `api.localhost:4820` as "api". Browsers resolve
// `*.localhost` to loopback themselves, so the addresses need no system setup.
func procHost(host string) (string, bool) {
	name := strings.ToLower(host)
	if i := strings.LastIndexByte(name, ':'); i >= 0 {
		name = name[:i]
	}
	return strings.CutSuffix(name, ".localhost")
}

// proxy forwards `<id>.localhost` traffic to the proc. For interposed procs
// the port is the observer, which records the exchange itself.
func proxy(sup *supervisor.Supervisor, id string, w http.ResponseWriter, r *http.Request) {
	port := sup.ProxyPort(id)
	if port == 0 {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		fmt.Fprintf(w, "procdeck: %q has no listening port yet — is it running?\n", id)
		return
	}
	record := sup.HTTPRecorder(id)
	if interpose.IsUpgrade(r) {
		interpose.ForwardUpgrade(w, r, port, record)
		return
	}
	interpose.Forward(w, r, port, record, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprintf(w, "procdeck: %q refused the connection on :%d\n", id, port)
	})
}

func apiHandler(sup *supervisor.Supervisor, deck Deck, hooks Hooks, ui fs.FS) http.Handler {
	h := &handler{sup: sup, deck: deck, hooks: hooks, ui: ui}
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+api+"/deck", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, http.StatusOK, deck) })
	mux.HandleFunc("GET "+api+"/procs", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, http.StatusOK, sup.List()) })
	mux.HandleFunc("GET "+api+"/instances", h.instances)
	mux.HandleFunc("POST "+api+"/shutdown", h.shutdown)
	mux.HandleFunc("GET "+api+"/events", h.events)
	mux.HandleFunc("GET "+api+"/logs", h.logs)
	mux.HandleFunc("GET "+api+"/http", h.traffic)
	mux.HandleFunc("POST "+api+"/marks", h.mark)
	mux.HandleFunc("POST "+api+"/procs/{id}/{action}", h.action)
	mux.HandleFunc("GET /manifest.webmanifest", h.manifest)
	mux.HandleFunc("GET /", h.static)
	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	encoder.Encode(v)
}

func badRequest(w http.ResponseWriter, format string, args ...any) {
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf(format, args...)})
}

var ok = map[string]bool{"ok": true}

// readBody decodes a small JSON body; a missing or malformed one leaves v as
// it was.
func readBody(w http.ResponseWriter, r *http.Request, v any) {
	json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(v)
}

func (h *handler) instances(w http.ResponseWriter, r *http.Request) {
	type entry struct {
		Name      string `json:"name"`
		Root      string `json:"root"`
		Port      int    `json:"port"`
		StartedAt int64  `json:"startedAt"`
		Version   string `json:"version"`
		Self      bool   `json:"self"`
	}
	entries := []entry{}
	for _, i := range h.hooks.Instances() {
		entries = append(entries, entry{i.Name, i.Root, i.Port, i.StartedAt, i.Version, i.Root == h.deck.Root})
	}
	writeJSON(w, http.StatusOK, entries)
}

// shutdown answers first, then goes down: the UI needs the 200 to know the
// click landed.
func (h *handler) shutdown(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, ok)
	time.AfterFunc(50*time.Millisecond, h.hooks.Shutdown)
}

// events is the SSE feed. Server-sent events rather than a WebSocket: the
// stream only flows towards the browser, and commands are plain POSTs.
func (h *handler) events(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.WriteHeader(http.StatusOK)
	flusher := http.NewResponseController(w)

	sub := h.sup.Subscribe()
	defer sub.Close()
	ticker := time.NewTicker(heartbeat)
	defer ticker.Stop()

	var frame bytes.Buffer
	for {
		if events := sub.Drain(); len(events) > 0 {
			frame.Reset()
			for _, event := range events {
				data, _ := json.Marshal(event)
				frame.WriteString("data: ")
				frame.Write(data)
				frame.WriteString("\n\n")
			}
			if _, err := w.Write(frame.Bytes()); err != nil || flusher.Flush() != nil {
				return
			}
		}
		select {
		case <-r.Context().Done():
			return
		case <-sub.Done():
			return
		case <-sub.Wake():
		case <-ticker.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil || flusher.Flush() != nil {
				return
			}
		}
	}
}

func (h *handler) action(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body struct {
		Cols int    `json:"cols"`
		Rows int    `json:"rows"`
		Data string `json:"data"`
	}
	readBody(w, r, &body)

	var err error
	switch r.PathValue("action") {
	case "start":
		err = h.sup.Start(id)
	case "stop":
		err = h.sup.Stop(id)
	case "restart":
		err = h.sup.Restart(id)
	case "resize":
		h.sup.Resize(id, body.Cols, body.Rows)
	case "input":
		h.sup.Write(id, body.Data)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown action"})
		return
	}
	if errors.Is(err, supervisor.ErrUnknownProc) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, ok)
}

func (h *handler) mark(w http.ResponseWriter, r *http.Request) {
	body := struct {
		Name string `json:"name"`
	}{Name: "default"}
	readBody(w, r, &body)
	if body.Name == "" || len(body.Name) > 64 {
		badRequest(w, "mark name must be 1–64 characters")
		return
	}
	writeJSON(w, http.StatusOK, h.sup.Mark(body.Name))
}

// cursors is the shared part of the /logs and /http queries: which procs,
// from where, until when.
type cursors struct {
	procs    []string
	sinceSeq map[string]int
	sinceMs  int64
	untilMs  int64
}

func parseCursors(q url.Values, fromMark func(supervisor.Mark) map[string]int, getMark func(string) (supervisor.Mark, bool)) (cursors, error) {
	var c cursors
	if raw := q.Get("procs"); raw != "" {
		for _, id := range strings.Split(raw, ",") {
			if id != "" {
				c.procs = append(c.procs, id)
			}
		}
	}
	for name, target := range map[string]*int64{"sinceMs": &c.sinceMs, "untilMs": &c.untilMs} {
		if raw := q.Get(name); raw != "" {
			value, err := strconv.ParseFloat(raw, 64)
			if err != nil || math.IsInf(value, 0) || math.IsNaN(value) {
				return c, fmt.Errorf("bad %s: %s", name, raw)
			}
			*target = int64(value)
		}
	}
	if name := q.Get("mark"); name != "" {
		mark, ok := getMark(name)
		if !ok {
			return c, fmt.Errorf("unknown mark %q — set one with POST /marks", name)
		}
		c.advance(fromMark(mark))
	}
	return c, nil
}

// advance merges cursors per proc; "since" only ever moves forward.
func (c *cursors) advance(seqs map[string]int) {
	if c.sinceSeq == nil {
		c.sinceSeq = map[string]int{}
	}
	for id, seq := range seqs {
		c.sinceSeq[id] = max(c.sinceSeq[id], seq)
	}
}

func parseLimit(raw string, fallback, ceiling int) (int, bool) {
	if raw == "" {
		return fallback, true
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 0 {
		return 0, false
	}
	return min(limit, ceiling), true
}

// logs is the agent-facing log query (also `procdeck logs`): `procs` (csv),
// `lines` (tail cap), `grep` (case-insensitive regexp), `sinceMs`/`untilMs`,
// `mark` (a named mark's snapshot), `sinceSeq` (a resume cursor — an integer
// for a single proc, or a JSON {proc: seq} record).
func (h *handler) logs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, valid := parseLimit(q.Get("lines"), defaultLogLines, maxLogLines)
	if !valid {
		badRequest(w, "bad lines: %s", q.Get("lines"))
		return
	}
	c, err := parseCursors(q, func(m supervisor.Mark) map[string]int { return m.Seqs }, h.sup.GetMark)
	if err != nil {
		badRequest(w, "%s", err)
		return
	}
	if raw := q.Get("sinceSeq"); raw != "" {
		if strings.HasPrefix(raw, "{") {
			var record map[string]int
			if json.Unmarshal([]byte(raw), &record) != nil {
				badRequest(w, "bad sinceSeq: %s — an integer or a {proc: seq} JSON record", raw)
				return
			}
			c.advance(record)
		} else {
			seq, err := strconv.Atoi(raw)
			if err != nil || len(c.procs) != 1 {
				badRequest(w, "a bare sinceSeq integer needs a single proc in `procs`")
				return
			}
			c.advance(map[string]int{c.procs[0]: seq})
		}
	}
	result, err := h.sup.Logs(lines.Query{
		Procs: c.procs, SinceSeq: c.sinceSeq, SinceMs: c.sinceMs, UntilMs: c.untilMs, Grep: q.Get("grep"), Limit: limit,
	})
	if err != nil {
		badRequest(w, "%s", err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// traffic is captured traffic (also `procdeck http`): the /logs cursors plus
// `status` ("5xx" / "422" / "error"), `path` (regexp), `kind` (http|ws) and
// `bodies=1`.
func (h *handler) traffic(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, valid := parseLimit(q.Get("limit"), defaultHTTP, maxHTTP)
	if !valid {
		badRequest(w, "bad limit: %s", q.Get("limit"))
		return
	}
	c, err := parseCursors(q, func(m supervisor.Mark) map[string]int { return m.HTTPSeqs }, h.sup.GetMark)
	if err != nil {
		badRequest(w, "%s", err)
		return
	}
	if raw := q.Get("sinceSeq"); raw != "" {
		var record map[string]int
		if json.Unmarshal([]byte(raw), &record) != nil {
			badRequest(w, "bad sinceSeq: %s — a {proc: seq} JSON record", raw)
			return
		}
		c.advance(record)
	}
	kind := httplog.Kind(q.Get("kind"))
	if kind != "" && kind != httplog.KindHTTP && kind != httplog.KindWS {
		badRequest(w, `bad kind: %s — "http" or "ws"`, kind)
		return
	}
	result, err := h.sup.HTTP(httplog.Query{
		Procs: c.procs, SinceSeq: c.sinceSeq, SinceMs: c.sinceMs, UntilMs: c.untilMs,
		Status: q.Get("status"), Path: q.Get("path"), Kind: kind, Bodies: q.Get("bodies") == "1", Limit: limit,
	})
	if err != nil {
		badRequest(w, "%s", err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// manifest is generated per deck so the installed app carries the project's
// name — every deck is its own origin (port), so its own app. No service
// worker on purpose: caching a dev tool's UI is a footgun.
func (h *handler) manifest(w http.ResponseWriter, r *http.Request) {
	type icon struct {
		Src     string `json:"src"`
		Sizes   string `json:"sizes"`
		Type    string `json:"type"`
		Purpose string `json:"purpose,omitempty"`
	}
	w.Header().Set("Content-Type", "application/manifest+json")
	json.NewEncoder(w).Encode(map[string]any{
		"name":             h.deck.Name + " · procdeck",
		"short_name":       h.deck.Name,
		"start_url":        "/",
		"scope":            "/",
		"display":          "standalone",
		"background_color": "#0e1116",
		"theme_color":      "#151a21",
		"icons": []icon{
			{"/icon-192.png", "192x192", "image/png", ""},
			{"/icon-512.png", "512x512", "image/png", ""},
			{"/icon-512.png", "512x512", "image/png", "maskable"},
		},
	})
}

var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript",
	".css":   "text/css",
	".map":   "application/json",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".woff2": "font/woff2",
}

// static serves the UI build; anything that is not a file falls back to
// index.html (a single-page app).
func (h *handler) static(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	data, err := fs.ReadFile(h.ui, name)
	if name == "" || err != nil {
		name = "index.html"
		data, err = fs.ReadFile(h.ui, name)
	}
	if err != nil {
		http.Error(w, "procdeck UI is not built — `pnpm --filter procdeck build`, then `go generate ./internal/webui`", http.StatusServiceUnavailable)
		return
	}
	contentType, known := contentTypes[path.Ext(name)]
	if !known {
		contentType = mime.TypeByExtension(path.Ext(name))
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Write(data)
}
