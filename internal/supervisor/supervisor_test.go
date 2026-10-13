package supervisor

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/kondaurovDev/procdeck/internal/config"
	"github.com/kondaurovDev/procdeck/internal/proc"
)

const longRunner = "echo up; exec sleep 1000"

func start(t *testing.T, procs ...config.Proc) *Supervisor {
	t.Helper()
	s, err := Start(&config.Loaded{Config: &config.Config{Procs: procs}, Root: t.TempDir(), Name: "test"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}

// reader pulls events from a subscription one at a time.
type reader struct {
	t       *testing.T
	sub     *Subscription
	pending []Event
}

func subscribe(t *testing.T, s *Supervisor) *reader {
	sub := s.Subscribe()
	t.Cleanup(sub.Close)
	return &reader{t: t, sub: sub}
}

func (r *reader) next(timeout time.Duration) (Event, bool) {
	deadline := time.After(timeout)
	for len(r.pending) == 0 {
		r.pending = r.sub.Drain()
		if len(r.pending) > 0 {
			break
		}
		select {
		case <-r.sub.Wake():
		case <-deadline:
			return Event{}, false
		}
	}
	e := r.pending[0]
	r.pending = r.pending[1:]
	return e, true
}

func (r *reader) until(what string, match func(Event) bool) Event {
	r.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		e, ok := r.next(time.Until(deadline))
		if !ok {
			r.t.Fatalf("timed out waiting for %s", what)
		}
		if match(e) {
			return e
		}
	}
}

func status(s *Supervisor, id string) Status {
	for _, info := range s.List() {
		if info.ID == id {
			return info.Status
		}
	}
	return Status{}
}

func TestAutostartStreamsLogsAndReportsExit(t *testing.T) {
	s := start(t, config.Proc{ID: "hello", Shell: "echo hello-from-child"})
	// Subscribing after the fact still sees the backlog: per-proc buffers.
	events := subscribe(t, s)
	events.until("the child's output", func(e Event) bool {
		return e.Type == EventLog && strings.Contains(e.Data, "hello-from-child")
	})
	events.until("a clean exit", func(e Event) bool {
		return e.Type == EventStatus && e.Status.State == Exited && *e.Status.ExitCode == 0
	})
}

func TestRestartSwapsPidAndKillsOldGroup(t *testing.T) {
	s := start(t, config.Proc{ID: "runner", Shell: longRunner})
	before := status(s, "runner").Pid
	if !proc.GroupAlive(before) {
		t.Fatal("runner is not alive")
	}
	if err := s.Restart("runner"); err != nil {
		t.Fatal(err)
	}
	after := status(s, "runner")
	if after.State != Running || after.Pid == before || after.Restarts != 1 {
		t.Fatalf("after restart: %+v", after)
	}
	if proc.GroupAlive(before) || !proc.GroupAlive(after.Pid) {
		t.Fatal("the old group survived or the new one is dead")
	}
}

func TestStopTerminatesAndReportsStopped(t *testing.T) {
	s := start(t, config.Proc{ID: "runner", Shell: longRunner})
	pid := status(s, "runner").Pid
	s.Stop("runner")
	if proc.GroupAlive(pid) || status(s, "runner").State != Stopped {
		t.Fatalf("after stop: alive=%v status=%+v", proc.GroupAlive(pid), status(s, "runner"))
	}
}

func TestAutostartFalseWaitsForStart(t *testing.T) {
	off := false
	s := start(t, config.Proc{ID: "lazy", Shell: longRunner, Autostart: &off})
	if status(s, "lazy").State != Stopped {
		t.Fatalf("lazy autostarted: %+v", status(s, "lazy"))
	}
	s.Start("lazy")
	if status(s, "lazy").State != Running {
		t.Fatalf("lazy did not start: %+v", status(s, "lazy"))
	}
}

func TestUnknownProc(t *testing.T) {
	s := start(t)
	for _, op := range []func(string) error{s.Start, s.Stop, s.Restart} {
		if err := op("ghost"); err == nil || err.Error() != `unknown proc "ghost"` {
			t.Errorf("err = %v", err)
		}
	}
}

func TestFailingProcMarksItself(t *testing.T) {
	s := start(t,
		config.Proc{ID: "broken", Cmd: []string{"definitely-not-a-real-binary-xyz"}},
		config.Proc{ID: "fine", Shell: longRunner},
	)
	events := subscribe(t, s)
	events.until("the reason in the pane", func(e Event) bool {
		return e.Type == EventLog && e.ID == "broken" && strings.Contains(e.Data, "spawn failed")
	})
	exited := events.until("broken to exit", func(e Event) bool {
		return e.Type == EventStatus && e.Status.ID == "broken" && e.Status.State == Exited
	})
	if *exited.Status.ExitCode == 0 {
		t.Fatal("a missing binary exited 0")
	}
	if status(s, "fine").State != Running {
		t.Fatalf("fine = %+v", status(s, "fine"))
	}
}

func TestCloseTerminatesEveryTree(t *testing.T) {
	s, err := Start(&config.Loaded{Config: &config.Config{Procs: []config.Proc{
		{ID: "one", Shell: longRunner},
		// A tree with a grandchild, to prove the group kill on shutdown.
		{ID: "two", Shell: "sleep 100 & sleep 60"},
	}}, Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	var pids []int
	for _, info := range s.List() {
		pids = append(pids, info.Status.Pid)
	}
	s.Close()
	for _, pid := range pids {
		if proc.GroupAlive(pid) {
			t.Errorf("pid %d survived Close", pid)
		}
	}
	// Nothing starts after Close.
	s.Start("one")
	if status(s, "one").State == Running {
		t.Fatal("a closed supervisor spawned")
	}
}

func TestBacklogIsPerProc(t *testing.T) {
	s := start(t,
		config.Proc{ID: "quiet", Shell: "echo quiet-hello; exec sleep 1000"},
		// ~1 MB of output, far past the 256 KB per-proc budget.
		config.Proc{ID: "chatty", Shell: `awk 'BEGIN { x = sprintf("%127s", ""); gsub(/ /, "x", x); for (i = 0; i < 8192; i++) print x i }'`},
	)
	first := subscribe(t, s)
	first.until("chatty to finish", func(e Event) bool {
		return e.Type == EventStatus && e.Status.ID == "chatty" && e.Status.State == Exited
	})

	late := subscribe(t, s)
	var backlog []Event
	for {
		e, ok := late.next(time.Second)
		if !ok {
			t.Fatal("no synced marker")
		}
		if e.Type == EventSynced {
			break
		}
		backlog = append(backlog, e)
	}
	var quiet, chatty []Event
	var statuses []string
	for _, e := range backlog {
		switch {
		case e.Type == EventStatus:
			statuses = append(statuses, e.Status.ID)
		case e.ID == "quiet":
			quiet = append(quiet, e)
		case e.ID == "chatty":
			chatty = append(chatty, e)
		}
	}
	// The quiet proc's line survived the neighbour's flood…
	if !slices.ContainsFunc(quiet, func(e Event) bool { return strings.Contains(e.Data, "quiet-hello") }) {
		t.Error("quiet's history was evicted")
	}
	// …and the flood itself is bounded, keeping its tail.
	bytes := 0
	for _, e := range chatty {
		bytes += len(e.Data)
	}
	if bytes > backlogBytes+64*1024 || !strings.Contains(chatty[len(chatty)-1].Data, "8191") {
		t.Errorf("chatty backlog: %d bytes, tail %q", bytes, chatty[len(chatty)-1].Data)
	}
	// Every proc's current status closes its backlog, in config order, and
	// seqs are monotonic.
	if !slices.Equal(statuses, []string{"quiet", "chatty"}) {
		t.Errorf("statuses = %q", statuses)
	}
	if !slices.IsSortedFunc(chatty, func(a, b Event) int { return a.Seq - b.Seq }) {
		t.Error("seqs are not monotonic")
	}
}

func TestNoDuplicateAtTheSeam(t *testing.T) {
	s := start(t, config.Proc{ID: "ticker", Shell: `i=0; while true; do echo "tick $i"; i=$((i+1)); sleep 0.005; done`})
	time.Sleep(200 * time.Millisecond)
	// Subscribe while it is talking, read for a while, check every seq once.
	events := subscribe(t, s)
	var seen []int
	synced := false
	deadline := time.Now().Add(400 * time.Millisecond)
	for time.Now().Before(deadline) {
		e, ok := events.next(time.Until(deadline))
		if !ok {
			break
		}
		if e.Type == EventSynced {
			synced = true
		}
		if e.Type == EventLog {
			seen = append(seen, e.Seq)
		}
	}
	if !synced || len(seen) < 10 {
		t.Fatalf("synced=%v, %d chunks", synced, len(seen))
	}
	for i := 1; i < len(seen); i++ {
		if seen[i] != seen[i-1]+1 {
			t.Fatalf("seq %d follows %d", seen[i], seen[i-1])
		}
	}
}

func TestInputAndResizeReachTheTerminal(t *testing.T) {
	s := start(t, config.Proc{ID: "echo", Shell: `read line; echo "got:$line"; stty size; exec sleep 1000`})
	events := subscribe(t, s)
	s.Resize("echo", 100, 40)
	s.Write("echo", "hello\r")
	events.until("the echoed line", func(e Event) bool { return e.Type == EventLog && strings.Contains(e.Data, "got:hello") })
	events.until("the new size", func(e Event) bool { return e.Type == EventLog && strings.Contains(e.Data, "40 100") })
}

func TestMarks(t *testing.T) {
	s := start(t, config.Proc{ID: "a", Shell: "echo one; exec sleep 1000"})
	subscribe(t, s).until("output", func(e Event) bool { return e.Type == EventLog && strings.Contains(e.Data, "one") })
	mark := s.Mark("m")
	if mark.Seqs["a"] != 1 || mark.HTTPSeqs["a"] != 0 {
		t.Fatalf("mark = %+v", mark)
	}
	if got, ok := s.GetMark("m"); !ok || got.At != mark.At {
		t.Fatalf("GetMark = %+v, %v", got, ok)
	}
	for i := range marksCap + 5 {
		s.Mark(strings.Repeat("x", i+1))
	}
	if _, ok := s.GetMark("m"); ok {
		t.Error("the oldest mark survived the cap")
	}
}
