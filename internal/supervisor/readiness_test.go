package supervisor

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kondaurovDev/procdeck/internal/config"
	"github.com/kondaurovDev/procdeck/internal/lines"
	"github.com/kondaurovDev/procdeck/internal/ports"
)

// TestMain doubles the test binary as a helper process: specs in these tests
// spawn it with PROCDECK_TEST_HELPER set, so listening children need neither
// node nor python. The mode is "listen:<port>:<delay ms>" for a bare TCP
// listener or "http:<port>:<delay ms>" for one answering "pinned-ok"; port 0
// asks the OS for one, "env" reads PORT.
func TestMain(m *testing.M) {
	if mode := os.Getenv("PROCDECK_TEST_HELPER"); mode != "" {
		helper(mode)
		return
	}
	os.Exit(m.Run())
}

func helper(mode string) {
	parts := strings.Split(mode, ":")
	port := parts[1]
	if port == "env" {
		port = os.Getenv("PORT")
	}
	delay, _ := strconv.Atoi(parts[2])
	time.Sleep(time.Duration(delay) * time.Millisecond)
	l, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		fmt.Println("listen failed:", err)
		os.Exit(1)
	}
	fmt.Printf("PORT:%d\n", l.Addr().(*net.TCPAddr).Port)
	if parts[0] == "http" {
		http.Serve(l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "pinned-ok") }))
	}
	for {
		time.Sleep(time.Hour)
	}
}

func listener(id, port string, delay time.Duration) config.Proc {
	return config.Proc{
		ID:  id,
		Cmd: []string{os.Args[0]},
		Env: map[string]string{"PROCDECK_TEST_HELPER": fmt.Sprintf("listen:%s:%d", port, delay.Milliseconds())},
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	free, err := ports.FindFree(1)
	if err != nil {
		t.Fatal(err)
	}
	return free[0]
}

func isStatus(id string, state State) func(Event) bool {
	return func(e Event) bool { return e.Type == EventStatus && e.Status.ID == id && e.Status.State == state }
}

// untilAll waits for several events whose order is not guaranteed.
func (r *reader) untilAll(what string, matches ...func(Event) bool) {
	r.t.Helper()
	pending := slices.Clone(matches)
	r.until(what, func(e Event) bool {
		pending = slices.DeleteFunc(pending, func(match func(Event) bool) bool { return match(e) })
		return len(pending) == 0
	})
}

var portLine = regexp.MustCompile(`PORT:(\d+)`)

func TestDetectsListeningPorts(t *testing.T) {
	s := start(t, listener("server", "0", 0))
	events := subscribe(t, s)
	// Learn the actual port from the child's own output…
	logged := events.until("the port line", func(e Event) bool { return e.Type == EventLog && portLine.MatchString(e.Data) })
	port, _ := strconv.Atoi(portLine.FindStringSubmatch(logged.Data)[1])
	// …and wait for the poll to discover the same port from the OS.
	events.until("the port in the status", func(e Event) bool {
		return e.Type == EventStatus && slices.Contains(e.Status.Ports, port)
	})
}

func TestNeedsWaitForTheDependencyToListen(t *testing.T) {
	s := start(t,
		// Listens only after a delay — the dependent must sit waiting.
		listener("api", "0", 400*time.Millisecond),
		config.Proc{ID: "web", Shell: longRunner, Needs: []string{"api"}},
	)
	if state := status(s, "web").State; state != Waiting {
		t.Fatalf("web = %s, want waiting", state)
	}
	subscribe(t, s).until("web to run", isStatus("web", Running))
	if len(status(s, "api").Ports) == 0 {
		t.Fatal("web started before api listened")
	}
}

func TestReadyWhenStarted(t *testing.T) {
	s := start(t,
		config.Proc{ID: "watcher", Shell: longRunner, ReadyWhen: config.ReadyStarted},
		config.Proc{ID: "web", Shell: longRunner, Needs: []string{"watcher"}},
	)
	subscribe(t, s).until("web to run", isStatus("web", Running))
}

func TestStopInterruptsWaiting(t *testing.T) {
	s := start(t,
		// Never listens → the dependent waits forever unless stopped.
		config.Proc{ID: "silent", Shell: longRunner},
		config.Proc{ID: "web", Shell: longRunner, Needs: []string{"silent"}},
	)
	if state := status(s, "web").State; state != Waiting {
		t.Fatalf("web = %s", state)
	}
	s.Stop("web")
	if state := status(s, "web").State; state != Stopped {
		t.Fatalf("web after stop = %s", state)
	}
}

func TestPreflightPasses(t *testing.T) {
	s := start(t, config.Proc{ID: "ok", Shell: longRunner, Preflight: &config.Preflight{Shell: "true"}})
	subscribe(t, s).until("ok to run", isStatus("ok", Running))
}

func TestFailingPreflightBlocksWithOutputAndHint(t *testing.T) {
	s := start(t, config.Proc{ID: "gated", Shell: longRunner, Preflight: &config.Preflight{
		Shell: "echo not-logged-in >&2; false",
		Hint:  "run pnpm cloudflare:login",
	}})
	events := subscribe(t, s)
	// The check's output and the hint land in the pane in one chunk, before
	// the status flips.
	events.until("output and hint", func(e Event) bool {
		return e.Type == EventLog && strings.Contains(e.Data, "not-logged-in") && strings.Contains(e.Data, "run pnpm cloudflare:login")
	})
	events.until("blocked", isStatus("gated", Blocked))
	if st := status(s, "gated"); st.Hint != "run pnpm cloudflare:login" || st.Pid != 0 {
		t.Fatalf("gated = %+v", st)
	}
}

func TestBlockedProcNeverBecomesReady(t *testing.T) {
	s := start(t,
		config.Proc{ID: "gated", Shell: longRunner, Preflight: &config.Preflight{Shell: "false"}},
		config.Proc{ID: "web", Shell: longRunner, Needs: []string{"gated"}},
	)
	subscribe(t, s).until("gated blocked", isStatus("gated", Blocked))
	if state := status(s, "web").State; state != Waiting {
		t.Fatalf("web = %s", state)
	}
}

func TestPreflightExpect(t *testing.T) {
	// The `wrangler whoami` case: the check exits 0 either way, and only its
	// output tells authenticated from not.
	s := start(t,
		config.Proc{ID: "gated", Shell: longRunner, Preflight: &config.Preflight{Shell: "echo you are NOT logged in", Expect: "You are logged in"}},
		config.Proc{ID: "ok", Shell: longRunner, Preflight: &config.Preflight{Shell: "echo You are logged in as x", Expect: "You are logged in"}},
	)
	events := subscribe(t, s)
	events.untilAll("gated blocked, ok running", isStatus("gated", Blocked), isStatus("ok", Running))
	if !strings.Contains(strings.Join(texts(s, "gated"), "\n"), "output lacks /You are logged in/") {
		t.Errorf("gated pane = %q", texts(s, "gated"))
	}
}

func texts(s *Supervisor, id string) []string {
	result, _ := s.Logs(lines.Query{Procs: []string{id}, Limit: 1000})
	var out []string
	for _, line := range result.Lines {
		out = append(out, line.Text)
	}
	return out
}

func TestStartRetriesThePreflight(t *testing.T) {
	flag := filepath.Join(t.TempDir(), "logged-in")
	s := start(t, config.Proc{ID: "gated", Shell: longRunner, Preflight: &config.Preflight{Shell: "test -f " + flag}})
	events := subscribe(t, s)
	events.until("blocked", isStatus("gated", Blocked))
	os.WriteFile(flag, nil, 0o644)
	s.Start("gated")
	events.until("running after the retry", isStatus("gated", Running))
}

func TestStrayPortDoesNotSatisfyURL(t *testing.T) {
	// Listens on a random port — think wrangler's login server on :8976 —
	// while the url promises another.
	api := listener("api", "0", 0)
	api.URL = fmt.Sprintf("http://localhost:%d", freePort(t))
	s := start(t, api, config.Proc{ID: "web", Shell: longRunner, Needs: []string{"api"}})
	subscribe(t, s).until("the stray port", func(e Event) bool {
		return e.Type == EventStatus && e.Status.ID == "api" && len(e.Status.Ports) > 0
	})
	if state := status(s, "web").State; state != Waiting {
		t.Fatalf("web = %s", state)
	}
}

func TestURLPortOpensReadiness(t *testing.T) {
	port := freePort(t)
	api := listener("api", strconv.Itoa(port), 0)
	api.URL = fmt.Sprintf("http://localhost:%d", port)
	s := start(t, api, config.Proc{ID: "web", Shell: longRunner, Needs: []string{"api"}})
	subscribe(t, s).until("web to run", isStatus("web", Running))
}

func TestPortAssignment(t *testing.T) {
	pin := freePort(t)
	off := false
	api := listener("api", "env", 0)
	api.Env["UNUSED"] = "${port}" // asks for an assigned port
	s := start(t,
		api,
		config.Proc{ID: "web", Shell: `echo "api-url=$API_URL"; exec sleep 1000`, Env: map[string]string{"API_URL": "http://localhost:${port:api}"}, Needs: []string{"api"}},
		// Unobserved, the pin itself is what the proc binds.
		config.Proc{ID: "pinned", Shell: `echo "pinned-port=$PORT"; exec sleep 1000`, Env: map[string]string{"X": "${port}"}, Port: &pin, Observe: &off},
		// Observed (the default), the proc binds a hidden internal port.
		config.Proc{ID: "observed", Shell: `echo "observed-port=$PORT"; exec sleep 1000`, Env: map[string]string{"X": "${port}"}},
	)
	infos := map[string]Info{}
	for _, info := range s.List() {
		infos[info.ID] = info
	}
	apiPort := infos["api"].AssignedPort
	if apiPort == 0 || infos["pinned"].AssignedPort != pin || infos["pinned"].URL != fmt.Sprintf("http://localhost:%d", pin) {
		t.Fatalf("infos = %+v", infos)
	}
	observedLine := regexp.MustCompile(`observed-port=(\d+)`)
	var observedPort int
	events := subscribe(t, s)
	// The internal port is the readiness port, and cross references see the
	// public one.
	events.untilAll("everyone up",
		func(e Event) bool {
			return e.Type == EventLog && strings.Contains(e.Data, fmt.Sprintf("api-url=http://localhost:%d", apiPort))
		},
		func(e Event) bool {
			return e.Type == EventLog && strings.Contains(e.Data, fmt.Sprintf("pinned-port=%d", pin))
		},
		func(e Event) bool {
			if m := observedLine.FindStringSubmatch(e.Data); e.Type == EventLog && m != nil {
				observedPort, _ = strconv.Atoi(m[1])
				return true
			}
			return false
		},
	)
	if observedPort == 0 || observedPort == infos["observed"].AssignedPort {
		t.Errorf("observed proc got PORT=%d, its public port is %d", observedPort, infos["observed"].AssignedPort)
	}
}

func TestAlertRaisedAndClearedOnStop(t *testing.T) {
	s := start(t, config.Proc{
		ID:     "chatty",
		Shell:  "echo 'Opening a link in your default browser'; exec sleep 1000",
		Alerts: []config.Alert{{Pattern: "Opening a link", Label: "needs login"}},
	})
	subscribe(t, s).until("the alert", func(e Event) bool { return e.Type == EventStatus && e.Status.Alert == "needs login" })
	s.Stop("chatty")
	if alert := status(s, "chatty").Alert; alert != "" {
		t.Fatalf("alert survived stop: %q", alert)
	}
}
