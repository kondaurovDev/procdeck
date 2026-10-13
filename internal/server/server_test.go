package server

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/kondaurovDev/procdeck/internal/config"
	"github.com/kondaurovDev/procdeck/internal/registry"
	"github.com/kondaurovDev/procdeck/internal/supervisor"
)

var ui = fstest.MapFS{
	"index.html":    {Data: []byte("<html>deck</html>")},
	"assets/app.js": {Data: []byte("console.log(1)")},
}

func serve(t *testing.T, procs ...config.Proc) (*httptest.Server, *supervisor.Supervisor) {
	t.Helper()
	root := t.TempDir()
	sup, err := supervisor.Start(&config.Loaded{Config: &config.Config{Procs: procs}, Root: root, Name: "test"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(sup.Close)
	hooks := Hooks{
		Shutdown:  func() {},
		Instances: func() []registry.Instance { return []registry.Instance{{Name: "test", Root: root, Port: 4820}} },
	}
	srv := httptest.NewServer(Handler(sup, Deck{Name: "test", Root: root, Port: 4820, Version: "dev"}, hooks, ui))
	t.Cleanup(srv.Close)
	return srv, sup
}

func call(t *testing.T, srv *httptest.Server, method, path, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(data)
}

func TestProcsAndDeck(t *testing.T) {
	srv, _ := serve(t, config.Proc{ID: "api", Shell: "exec sleep 1000"})
	code, body := call(t, srv, "GET", api+"/procs", "")
	var procs []supervisor.Info
	json.Unmarshal([]byte(body), &procs)
	if code != 200 || len(procs) != 1 || procs[0].ID != "api" || procs[0].ProxyURL != "http://api.localhost:4820" {
		t.Fatalf("%d %s", code, body)
	}
	if code, body := call(t, srv, "GET", api+"/deck", ""); code != 200 || !strings.Contains(body, `"name":"test"`) {
		t.Fatalf("deck: %d %s", code, body)
	}
	if code, body := call(t, srv, "GET", api+"/instances", ""); code != 200 || !strings.Contains(body, `"self":true`) {
		t.Fatalf("instances: %d %s", code, body)
	}
}

func TestActions(t *testing.T) {
	srv, sup := serve(t, config.Proc{ID: "api", Shell: "exec sleep 1000"})
	if code, body := call(t, srv, "POST", api+"/procs/api/stop", "{}"); code != 200 || body != "{\"ok\":true}\n" {
		t.Fatalf("stop: %d %s", code, body)
	}
	if state := sup.List()[0].Status.State; state != supervisor.Stopped {
		t.Fatalf("state after stop = %s", state)
	}
	if code, body := call(t, srv, "POST", api+"/procs/ghost/restart", ""); code != 404 || !strings.Contains(body, `unknown proc \"ghost\"`) {
		t.Fatalf("unknown proc: %d %s", code, body)
	}
	if code, _ := call(t, srv, "POST", api+"/procs/api/explode", ""); code != 404 {
		t.Fatalf("unknown action: %d", code)
	}
	// Input and resize to a stopped or unknown proc are harmless.
	if code, _ := call(t, srv, "POST", api+"/procs/api/input", `{"data":"x"}`); code != 200 {
		t.Fatalf("input: %d", code)
	}
}

func TestEventsStartWithTheSnapshot(t *testing.T) {
	srv, _ := serve(t, config.Proc{ID: "hello", Shell: "echo hello-sse; exec sleep 1000"})
	res, err := http.Get(srv.URL + api + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("content type %q", res.Header.Get("Content-Type"))
	}
	scanner := bufio.NewScanner(res.Body)
	var types []string
	for scanner.Scan() {
		data, ok := strings.CutPrefix(scanner.Text(), "data: ")
		if !ok {
			continue
		}
		var event struct{ Type string }
		json.Unmarshal([]byte(data), &event)
		types = append(types, event.Type)
		if event.Type == "synced" {
			break
		}
	}
	if len(types) < 2 || types[len(types)-2] != "status" {
		t.Fatalf("event types = %q", types)
	}
}

func TestLogsAndMarks(t *testing.T) {
	srv, _ := serve(t, config.Proc{ID: "api", Shell: "exec sleep 1000"})
	if code, body := call(t, srv, "GET", api+"/logs?lines=-1", ""); code != 400 || !strings.Contains(body, "bad lines") {
		t.Fatalf("bad lines: %d %s", code, body)
	}
	if code, body := call(t, srv, "GET", api+"/logs?mark=nope", ""); code != 400 || !strings.Contains(body, `unknown mark \"nope\"`) {
		t.Fatalf("unknown mark: %d %s", code, body)
	}
	if code, body := call(t, srv, "GET", api+"/logs?sinceSeq=3", ""); code != 400 {
		t.Fatalf("bare sinceSeq without one proc: %d %s", code, body)
	}
	if code, body := call(t, srv, "POST", api+"/marks", `{"name":"m"}`); code != 200 || !strings.Contains(body, `"name":"m"`) {
		t.Fatalf("mark: %d %s", code, body)
	}
	if code, body := call(t, srv, "GET", api+"/logs?mark=m&procs=api", ""); code != 200 || !strings.Contains(body, `"lines":[]`) {
		t.Fatalf("since mark: %d %s", code, body)
	}
	if code, body := call(t, srv, "GET", api+"/http?limit=300&bodies=1&sinceSeq=%7B%22api%22%3A0%7D", ""); code != 200 || !strings.Contains(body, `"exchanges":[]`) {
		t.Fatalf("http: %d %s", code, body)
	}
	if code, _ := call(t, srv, "GET", api+"/http?kind=smoke", ""); code != 400 {
		t.Fatalf("bad kind: %d", code)
	}
}

func TestStaticUI(t *testing.T) {
	srv, _ := serve(t)
	for path, want := range map[string]string{
		"/":              "<html>deck</html>",
		"/assets/app.js": "console.log(1)",
		"/some/route":    "<html>deck</html>", // single-page app fallback
	} {
		if code, body := call(t, srv, "GET", path, ""); code != 200 || body != want {
			t.Errorf("GET %s: %d %q", path, code, body)
		}
	}
	res, _ := http.Get(srv.URL + "/assets/app.js")
	if ct := res.Header.Get("Content-Type"); ct != "text/javascript" {
		t.Errorf("content type %q", ct)
	}
	if code, body := call(t, srv, "GET", "/manifest.webmanifest", ""); code != 200 || !strings.Contains(body, "test · procdeck") {
		t.Errorf("manifest: %d %s", code, body)
	}

	unbuilt := httptest.NewServer(Handler(nil, Deck{}, Hooks{}, fstest.MapFS{}))
	defer unbuilt.Close()
	if code, _ := call(t, unbuilt, "GET", "/", ""); code != 503 {
		t.Errorf("unbuilt UI: %d", code)
	}
}
