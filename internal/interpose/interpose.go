// Package interpose is the capture-aware HTTP forwarding shared by procdeck's
// two interception points (docs/design/http-observability.md):
//
//  1. the `*.localhost` reverse proxy in the server — browser → service;
//  2. the per-proc observer: procdeck listens on the public assigned port
//     (`${port:api}` resolves to it) and forwards to the hidden internal port
//     the proc actually binds — server-to-server capture with zero app
//     changes.
//
// Every exchange is handed to a Record callback; bodies are teed through
// httplog.BodyTap (text only, truncated), headers are redacted before they
// are stored. Not net/http/httputil.ReverseProxy: its upgrade path cannot be
// tapped, and it rewrites headers in ways the capture must not see.
package interpose

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/kondaurovDev/procdeck/internal/httplog"
	"github.com/kondaurovDev/procdeck/internal/wsframe"
)

// Record receives one captured exchange or message. It is nil where another
// tap already sees the traffic (the UI proxy forwarding into an observed
// public port must not double-count).
type Record func(httplog.Capture)

// transport dials upstream as `localhost`, not a literal 127.0.0.1: dev
// servers bound with listen(port, "localhost") often end up on [::1] only,
// and Go's dialer races both families the way a browser does. No
// compression is negotiated — the capture must see the bytes the proc sent —
// and no proxy from the environment applies to loopback.
var transport = &http.Transport{
	Proxy:               nil,
	DisableCompression:  true,
	MaxIdleConnsPerHost: 32,
	IdleConnTimeout:     30 * time.Second,
	DialContext:         (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
}

// hopHeaders are meaningful for a single connection and never forwarded.
var hopHeaders = []string{
	"Connection", "Keep-Alive", "Proxy-Connection", "Proxy-Authenticate", "Proxy-Authorization",
	"Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

func stripHopHeaders(h http.Header) {
	for _, field := range h.Values("Connection") {
		for _, name := range strings.Split(field, ",") {
			h.Del(strings.TrimSpace(name))
		}
	}
	for _, name := range hopHeaders {
		h.Del(name)
	}
}

// upstreamHeaders are the client's headers for the hop to the proc. The Host
// becomes localhost:<port> so host allowlists (vite) stay happy, while the
// original survives in X-Forwarded-Host — frameworks that CSRF-check Origin
// against the forwarded host (Next.js Server Actions) depend on it.
func upstreamHeaders(r *http.Request) http.Header {
	h := r.Header.Clone()
	if h.Get("X-Forwarded-Host") == "" && r.Host != "" {
		h.Set("X-Forwarded-Host", r.Host)
	}
	// The observer only ever speaks plain http; an outer proxy that
	// terminated TLS already said so and wins.
	if h.Get("X-Forwarded-Proto") == "" {
		h.Set("X-Forwarded-Proto", "http")
	}
	if client, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		if prior := h.Get("X-Forwarded-For"); prior != "" {
			client = prior + ", " + client
		}
		h.Set("X-Forwarded-For", client)
	}
	// Present but empty: Go sends no User-Agent of its own.
	if _, ok := h["User-Agent"]; !ok {
		h["User-Agent"] = []string{""}
	}
	return h
}

// clientHeaders are the headers as the client sent them, for the capture —
// net/http keeps Host and Content-Length out of r.Header.
func clientHeaders(r *http.Request) map[string]string {
	h := r.Header.Clone()
	h.Set("Host", r.Host)
	if r.ContentLength > 0 {
		h.Set("Content-Length", strconv.FormatInt(r.ContentLength, 10))
	}
	if len(r.TransferEncoding) > 0 {
		h.Set("Transfer-Encoding", strings.Join(r.TransferEncoding, ", "))
	}
	return httplog.RedactHeaders(h)
}

// requestURI is the path + query exactly as the client sent it.
func requestURI(r *http.Request) string {
	if strings.HasPrefix(r.RequestURI, "/") {
		return r.RequestURI
	}
	return r.URL.RequestURI()
}

// IsUpgrade reports a request asking to switch protocols (WebSocket).
func IsUpgrade(r *http.Request) bool {
	return r.Header.Get("Upgrade") != "" && strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade")
}

// Forward relays one request to localhost:<port> and streams the answer
// back, recording the exchange. onError answers when the upstream cannot be
// reached; nil means a plain 502.
func Forward(w http.ResponseWriter, r *http.Request, port int, record Record, onError func(http.ResponseWriter)) {
	started := time.Now()
	path := requestURI(r)
	target, err := url.Parse(fmt.Sprintf("http://localhost:%d%s", port, path))
	if err != nil {
		http.Error(w, "procdeck: bad request target", http.StatusBadRequest)
		return
	}

	var reqTap, resTap *httplog.BodyTap
	body := io.Reader(r.Body)
	if record != nil {
		reqTap = httplog.NewBodyTap(httplog.IsTextType(r.Header.Get("Content-Type")))
		body = io.TeeReader(r.Body, reqTap)
	}
	out := &http.Request{
		Method:        r.Method,
		URL:           target,
		Host:          target.Host,
		Header:        upstreamHeaders(r),
		Body:          io.NopCloser(body),
		ContentLength: r.ContentLength,
	}
	stripHopHeaders(out.Header)
	if r.ContentLength == 0 {
		out.Body = http.NoBody
	}
	// The client's context: a closed tab or a cancelled fetch cancels the
	// upstream too, instead of letting it stream to completion unseen.
	out = out.WithContext(r.Context())

	status := 0
	var resHeaders map[string]string
	if record != nil {
		defer func() {
			capture := httplog.Capture{
				Kind: httplog.KindHTTP, TS: started.UnixMilli(), Method: r.Method, Path: path, Status: status,
				DurationMs: time.Since(started).Milliseconds(), ReqBytes: reqTap.Bytes, ReqBody: reqTap.Body(),
				ReqHeaders: clientHeaders(r), ResHeaders: resHeaders,
			}
			if resTap != nil {
				capture.ResBytes, capture.ResBody = resTap.Bytes, resTap.Body()
			}
			record(capture)
		}()
	}

	res, err := transport.RoundTrip(out)
	if err != nil {
		if r.Context().Err() != nil {
			return // the client left; nobody to answer
		}
		if onError != nil {
			onError(w)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprintf(w, "procdeck: upstream refused the connection on :%d\n", port)
		return
	}
	defer res.Body.Close()

	if record != nil {
		resTap = httplog.NewBodyTap(httplog.IsTextType(res.Header.Get("Content-Type")))
		resHeaders = httplog.RedactHeaders(res.Header)
	}
	stripHopHeaders(res.Header)
	for name, values := range res.Header {
		w.Header()[name] = values
	}
	w.WriteHeader(res.StatusCode)

	// Stream, flushing each chunk: server-sent events and long polls must
	// reach the client as they happen.
	flusher := http.NewResponseController(w)
	buf := make([]byte, 32*1024)
	for {
		n, readErr := res.Body.Read(buf)
		if n > 0 {
			if resTap != nil {
				resTap.Write(buf[:n])
			}
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				return // the client left mid-body; status stays "never answered"
			}
			flusher.Flush()
		}
		if errors.Is(readErr, io.EOF) {
			status = res.StatusCode
			return
		}
		if readErr != nil {
			if r.Context().Err() != nil {
				return
			}
			// The upstream died mid-body. Appending an error note would
			// corrupt the payload — cut the connection so the truncation is
			// unmistakable.
			status = res.StatusCode
			panic(http.ErrAbortHandler)
		}
	}
}

// nextConnID ties a 101 exchange to the WebSocket messages on its socket.
var nextConnID atomic.Int64

// ForwardUpgrade passes a WebSocket (or any Upgrade) through. The handshake
// is recorded as a normal exchange (status 101) carrying a connId; every
// text/binary message on the socket is then captured as a ws entry with the
// same connId.
func ForwardUpgrade(w http.ResponseWriter, r *http.Request, port int, record Record) {
	started := time.Now()
	path := requestURI(r)
	connID := 0
	header := r.Header.Clone()
	if record != nil {
		connID = int(nextConnID.Add(1))
		// No compression may be negotiated where we capture: stripping the
		// offer keeps every payload plain frames. Free on loopback.
		header.Del("Sec-WebSocket-Extensions")
	}
	r.Header = header
	finish := func(status int, resHeaders map[string]string) {
		if record != nil {
			record(httplog.Capture{
				Kind: httplog.KindHTTP, TS: started.UnixMilli(), Method: r.Method, Path: path, Status: status,
				DurationMs: time.Since(started).Milliseconds(), ReqHeaders: clientHeaders(r), ResHeaders: resHeaders,
				ConnID: connID,
			})
		}
	}

	upstream, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(r.Context(), "tcp", net.JoinHostPort("localhost", strconv.Itoa(port)))
	if err != nil {
		finish(0, nil)
		http.Error(w, fmt.Sprintf("procdeck: upstream refused the connection on :%d", port), http.StatusBadGateway)
		return
	}
	target, _ := url.Parse(path)
	handshake := &http.Request{Method: r.Method, URL: target, Host: fmt.Sprintf("localhost:%d", port), Header: upstreamHeaders(r)}
	upstreamReader := bufio.NewReader(upstream)
	var res *http.Response
	if err = handshake.Write(upstream); err == nil {
		res, err = http.ReadResponse(upstreamReader, handshake)
	}
	if err != nil {
		upstream.Close()
		finish(0, nil)
		http.Error(w, "procdeck: upstream broke off the handshake", http.StatusBadGateway)
		return
	}

	if res.StatusCode != http.StatusSwitchingProtocols {
		// The upstream answered without upgrading — relay the refusal and
		// hang up.
		defer upstream.Close()
		defer res.Body.Close()
		finish(res.StatusCode, httplog.RedactHeaders(res.Header))
		for name, values := range res.Header {
			w.Header()[name] = values
		}
		w.Header().Set("Connection", "close")
		w.WriteHeader(res.StatusCode)
		io.Copy(w, io.LimitReader(res.Body, 1<<20))
		return
	}
	finish(http.StatusSwitchingProtocols, httplog.RedactHeaders(res.Header))

	client, clientBuf, err := http.NewResponseController(w).Hijack()
	if err != nil {
		upstream.Close()
		return
	}
	fmt.Fprintf(client, "HTTP/1.1 101 Switching Protocols\r\n")
	res.Header.Write(client)
	io.WriteString(client, "\r\n")

	// Tap both directions before any post-handshake byte flows: "in" is
	// client → proc, "out" is proc → client. The taps only observe.
	tapIn, tapOut := io.Writer(io.Discard), io.Writer(io.Discard)
	if record != nil {
		tapIn = &messageTap{record: record, connID: connID, dir: "in", path: path}
		tapOut = &messageTap{record: record, connID: connID, dir: "out", path: path}
	}
	// Bytes already buffered on either side belong to the stream.
	toClient := io.MultiReader(bufferedOf(upstreamReader), upstream)
	toUpstream := io.MultiReader(bufferedOf(clientBuf.Reader), client)

	var once sync.Once
	closeBoth := func() {
		once.Do(func() {
			client.Close()
			upstream.Close()
		})
	}
	go func() {
		io.Copy(io.MultiWriter(upstream, tapIn), toUpstream)
		closeBoth()
	}()
	io.Copy(io.MultiWriter(client, tapOut), toClient)
	closeBoth()
}

func bufferedOf(r *bufio.Reader) io.Reader {
	data, _ := r.Peek(r.Buffered())
	return strings.NewReader(string(data))
}

// messageTap parses one direction of a WebSocket into messages and records
// them.
type messageTap struct {
	record Record
	connID int
	dir    string
	path   string
	parser wsframe.Parser
}

func (t *messageTap) Write(p []byte) (int, error) {
	for _, message := range t.parser.Push(p) {
		capture := httplog.Capture{
			Kind: httplog.KindWS, TS: time.Now().UnixMilli(), ConnID: t.connID, Dir: t.dir,
			Opcode: message.Opcode, Path: t.path, Size: int64(message.Size),
		}
		if message.Opcode == "text" {
			capture.Text = strings.ToValidUTF8(string(message.Data), "�")
		}
		t.record(capture)
	}
	return len(p), nil
}

// Observer is the per-proc observer: it listens on the public assigned port,
// forwards to the hidden internal one and records everything. Loopback only,
// like the assigned ports themselves.
type Observer struct {
	server *http.Server
}

// Handler forwards every request and upgrade to localhost:<port>.
func Handler(port int, record Record) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if IsUpgrade(r) {
			ForwardUpgrade(w, r, port, record)
			return
		}
		Forward(w, r, port, record, nil)
	})
}

// StartObserver binds the public port; it fails when something holds it.
func StartObserver(publicPort, internalPort int, record Record) (*Observer, error) {
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(publicPort)))
	if err != nil {
		return nil, err
	}
	server := &http.Server{
		Handler:           Handler(internalPort, record),
		ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
	go server.Serve(listener)
	return &Observer{server: server}, nil
}

// Close stops listening and drops every open connection.
func (o *Observer) Close() { o.server.Close() }
