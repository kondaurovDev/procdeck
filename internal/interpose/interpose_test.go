package interpose

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kondaurovDev/procdeck/internal/httplog"
)

// The observer's forwarding edge cases, exercised directly: a throwaway
// target server on a random internal port, the observer in front of it.

type recorder struct {
	mu       sync.Mutex
	captures []httplog.Capture
}

func (r *recorder) record(c httplog.Capture) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.captures = append(r.captures, c)
}

func (r *recorder) all() []httplog.Capture {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]httplog.Capture(nil), r.captures...)
}

// observe starts a target and an observer in front of it; it returns the
// observer's URL.
func observe(t *testing.T, target http.HandlerFunc, rec *recorder) string {
	t.Helper()
	upstream := httptest.NewServer(target)
	t.Cleanup(upstream.Close)
	port := upstream.Listener.Addr().(*net.TCPAddr).Port
	var record Record
	if rec != nil {
		record = rec.record
	}
	front := httptest.NewServer(Handler(port, record))
	t.Cleanup(front.Close)
	return front.URL
}

func until(t *testing.T, what string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestClientAbortPropagatesUpstream(t *testing.T) {
	// Without propagation a cancelled browser request (closed tab, aborted
	// fetch) leaves the upstream streaming to completion unseen.
	var upstreamClosed atomic.Bool
	url := observe(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("first chunk"))
		w.(http.Flusher).Flush()
		<-r.Context().Done() // …and keep the response open until the client leaves
		upstreamClosed.Store(true)
	}, nil)

	res, err := http.Get(url + "/stream")
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	res.Body.Read(buf)
	res.Body.Close()
	until(t, "the upstream to see the abort", upstreamClosed.Load)
}

func TestUpstreamDyingMidBodyTruncates(t *testing.T) {
	url := observe(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Write([]byte("partial"))
		w.(http.Flusher).Flush()
		time.Sleep(50 * time.Millisecond)
		conn, _, _ := http.NewResponseController(w).Hijack()
		conn.Close()
	}, nil)

	res, err := http.Get(url + "/dies")
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || string(body) != "partial" || readErr == nil {
		t.Fatalf("status %d, body %q, read error %v — want a truncated 200", res.StatusCode, body, readErr)
	}
}

func TestForwardedHeadersIdentifyTheOriginalHop(t *testing.T) {
	url := observe(t, func(w http.ResponseWriter, r *http.Request) {
		seen := map[string]string{"host": r.Host, "user-agent": r.Header.Get("User-Agent"), "accept-encoding": r.Header.Get("Accept-Encoding")}
		for name := range r.Header {
			seen[strings.ToLower(name)] = r.Header.Get(name)
		}
		json.NewEncoder(w).Encode(seen)
	}, nil)

	req, _ := http.NewRequest("GET", url+"/headers", nil)
	req.Host = "localhost:3002"
	req.Header.Set("User-Agent", "")
	res, err := http.DefaultTransport.(*http.Transport).Clone().RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	var seen map[string]string
	json.NewDecoder(res.Body).Decode(&seen)
	res.Body.Close()
	if seen["x-forwarded-host"] != "localhost:3002" || seen["x-forwarded-proto"] != "http" || !strings.Contains(seen["x-forwarded-for"], "127.0.0.1") {
		t.Errorf("forwarded headers = %v", seen)
	}
	if seen["host"] == "localhost:3002" {
		t.Error("the Host was not rewritten to the upstream")
	}
	// What the client sent is what arrives — no User-Agent or gzip of ours.
	if seen["user-agent"] != "" {
		t.Errorf("user-agent = %q", seen["user-agent"])
	}
}

func TestRecordsTheExchange(t *testing.T) {
	rec := &recorder{}
	url := observe(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTeapot)
		w.Write(body)
	}, rec)

	req, _ := http.NewRequest("POST", url+"/echo?x=1", strings.NewReader(`{"secret":"payload-42"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer very-secret")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.ReadAll(res.Body)
	res.Body.Close()

	until(t, "the capture", func() bool { return len(rec.all()) == 1 })
	c := rec.all()[0]
	if c.Method != "POST" || c.Path != "/echo?x=1" || c.Status != 418 || c.ReqBytes != 23 || c.ResBytes != 23 {
		t.Errorf("capture = %+v", c)
	}
	if !strings.Contains(c.ReqBody, "payload-42") || !strings.Contains(c.ResBody, "payload-42") {
		t.Errorf("bodies = %q / %q", c.ReqBody, c.ResBody)
	}
	if c.ReqHeaders["authorization"] != "[redacted]" || !strings.HasPrefix(c.ReqHeaders["host"], "127.0.0.1:") {
		t.Errorf("request headers = %v", c.ReqHeaders)
	}
}

func TestRefusedUpstreamAnswers502AndRecordsZero(t *testing.T) {
	free, _ := net.Listen("tcp", "127.0.0.1:0")
	port := free.Addr().(*net.TCPAddr).Port
	free.Close()
	rec := &recorder{}
	front := httptest.NewServer(Handler(port, rec.record))
	defer front.Close()
	res, err := http.Get(front.URL + "/nobody")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 502 || !strings.Contains(string(body), "refused the connection on :"+strconv.Itoa(port)) {
		t.Fatalf("%d %q", res.StatusCode, body)
	}
	until(t, "the capture", func() bool { return len(rec.all()) == 1 && rec.all()[0].Status == 0 })
}

// wsServer accepts any upgrade, greets with a text frame and ignores
// whatever the client sends.
func wsServer(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Sec-WebSocket-Extensions") != "" {
		http.Error(w, "extensions must have been stripped", http.StatusBadRequest)
		return
	}
	sum := sha1.Sum([]byte(r.Header.Get("Sec-WebSocket-Key") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	conn, buf, _ := http.NewResponseController(w).Hijack()
	defer conn.Close()
	buf.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n")
	buf.WriteString("Sec-WebSocket-Accept: " + base64.StdEncoding.EncodeToString(sum[:]) + "\r\n\r\n")
	buf.Write([]byte{0x81, 7})
	buf.WriteString("welcome")
	buf.Flush()
	io.Copy(io.Discard, buf)
}

func TestWebSocketMessagesAreCaptured(t *testing.T) {
	rec := &recorder{}
	url := observe(t, wsServer, rec)
	conn, err := net.Dial("tcp", strings.TrimPrefix(url, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	io.WriteString(conn, "GET /chat?room=7 HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"+
		"Sec-WebSocket-Extensions: permessage-deflate\r\n\r\n")
	reader := bufio.NewReader(conn)
	res, err := http.ReadResponse(reader, nil)
	if err != nil || res.StatusCode != 101 {
		t.Fatalf("handshake: %v %v", res, err)
	}
	greeting := make([]byte, 9)
	io.ReadFull(reader, greeting)
	if string(greeting[2:]) != "welcome" {
		t.Fatalf("greeting %q", greeting)
	}
	// A masked client frame: "hello from client".
	payload := []byte("hello from client")
	mask := []byte{1, 2, 3, 4}
	frame := append([]byte{0x81, 0x80 | byte(len(payload))}, mask...)
	for i, b := range payload {
		frame = append(frame, b^mask[i%4])
	}
	conn.Write(frame)

	until(t, "three captures", func() bool { return len(rec.all()) == 3 })
	var upgrade, in, out httplog.Capture
	for _, c := range rec.all() {
		switch {
		case !c.IsWS():
			upgrade = c
		case c.Dir == "in":
			in = c
		default:
			out = c
		}
	}
	if upgrade.Status != 101 || upgrade.ConnID == 0 || upgrade.Path != "/chat?room=7" {
		t.Errorf("upgrade = %+v", upgrade)
	}
	if in.Text != "hello from client" || in.Size != 17 || in.ConnID != upgrade.ConnID {
		t.Errorf("in = %+v", in)
	}
	if out.Text != "welcome" || out.Opcode != "text" || out.Path != "/chat?room=7" || out.ConnID != upgrade.ConnID {
		t.Errorf("out = %+v", out)
	}
}
