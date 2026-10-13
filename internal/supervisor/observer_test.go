package supervisor

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kondaurovDev/procdeck/internal/config"
	"github.com/kondaurovDev/procdeck/internal/httplog"
)

// pinnedServer answers HTTP on the PORT it is handed, behind a pin.
func pinnedServer(id string, pin int) config.Proc {
	return config.Proc{
		ID:   id,
		Cmd:  []string{os.Args[0]},
		Env:  map[string]string{"PROCDECK_TEST_HELPER": "http:env:0", "WANTS": "${port}"},
		Port: &pin,
	}
}

// get retries until the port answers: the proc needs a moment to bind.
func get(t *testing.T, url string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		res, err := http.Get(url)
		if err == nil {
			body, _ := io.ReadAll(res.Body)
			res.Body.Close()
			if res.StatusCode == 200 {
				return string(body)
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("GET %s: no answer (%v)", url, err)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func TestPinnedPortIsTheObservedPublicSide(t *testing.T) {
	pin := freePort(t)
	s := start(t, pinnedServer("api", pin))
	info := s.List()[0]
	if info.AssignedPort != pin || info.URL != fmt.Sprintf("http://localhost:%d", pin) {
		t.Fatalf("info = %+v", info)
	}
	// The pin answers through the observer while the proc itself binds a
	// hidden internal port — so the exchange is also captured.
	if body := get(t, fmt.Sprintf("http://127.0.0.1:%d/hello", pin)); body != "pinned-ok" {
		t.Fatalf("body = %q", body)
	}
	result, _ := s.HTTP(httplog.Query{Procs: []string{"api"}, Limit: 10})
	if !slices.ContainsFunc(result.Exchanges, func(e httplog.Entry) bool { return e.Path == "/hello" }) {
		t.Fatalf("captured = %+v", result.Exchanges)
	}
	// The proxy forwards into the observer, which already records.
	if s.HTTPRecorder("api") != nil {
		t.Error("an observed proc must not be recorded twice")
	}
	if s.ProxyPort("api") != pin {
		t.Errorf("proxy port = %d", s.ProxyPort("api"))
	}
}

func TestTakenPinParksAndStartRetries(t *testing.T) {
	pin := freePort(t)
	// Somebody else holds the pinned port — the same service started outside
	// procdeck, as far as the deck can tell.
	holder, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(pin))
	if err != nil {
		t.Fatal(err)
	}
	s := start(t, pinnedServer("api", pin), config.Proc{ID: "fine", Shell: longRunner})

	// Only the pinned proc is parked; the deck itself is up.
	if st := status(s, "api"); st.State != Blocked || !strings.Contains(st.Hint, fmt.Sprintf(":%d", pin)) {
		t.Fatalf("api = %+v", st)
	}
	if state := status(s, "fine").State; state != Running {
		t.Fatalf("fine = %s", state)
	}
	// Starting while the port is still taken parks it again…
	s.Start("api")
	if state := status(s, "api").State; state != Blocked {
		t.Fatalf("api after a retry on a taken port = %s", state)
	}
	// …and once the holder lets go, Start binds the observer and spawns.
	holder.Close()
	s.Start("api")
	if state := status(s, "api").State; state != Running {
		t.Fatalf("api after the port freed = %s", state)
	}
	if body := get(t, fmt.Sprintf("http://127.0.0.1:%d/retry", pin)); body != "pinned-ok" {
		t.Fatalf("body = %q", body)
	}
}

func TestUnobservedProcIsRecordedByTheProxy(t *testing.T) {
	off := false
	proc := listener("raw", "env", 0)
	proc.Env["WANTS"] = "${port}"
	proc.Observe = &off
	s := start(t, proc)
	if s.HTTPRecorder("raw") == nil {
		t.Fatal("an unobserved proc needs the proxy to record")
	}
	if s.ProxyPort("raw") != s.List()[0].AssignedPort {
		t.Errorf("proxy port = %d, assigned %d", s.ProxyPort("raw"), s.List()[0].AssignedPort)
	}
}
