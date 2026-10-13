package proc

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kondaurovDev/procdeck/internal/config"
)

// Integration tests against real processes — no mocks on purpose: the risks
// here (PTY semantics, process groups, signal escalation) live at the OS
// boundary, which is exactly what a mock would fake away.

type output struct {
	mu   sync.Mutex
	text strings.Builder
}

func (o *output) write(data string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.text.WriteString(data)
}

func (o *output) contains(s string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return strings.Contains(o.text.String(), s)
}

func spawn(t *testing.T, spec config.Proc) (*Proc, *output) {
	t.Helper()
	out := &output{}
	p, err := Spawn(Options{Spec: spec, Dir: t.TempDir(), Cols: 80, Rows: 24, OnData: out.write})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { KillGroup(p.Pid, 9) })
	return p, out
}

func until(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestChildrenSeeATTY(t *testing.T) {
	p, out := spawn(t, config.Proc{ID: "tty", Shell: "test -t 1 && echo tty-yes || echo tty-no"})
	<-p.Done()
	until(t, "tty-yes", func() bool { return out.contains("tty-yes") })
}

func TestShellAndCmd(t *testing.T) {
	p, out := spawn(t, config.Proc{ID: "shell", Shell: "echo one && echo two"})
	<-p.Done()
	until(t, "both lines", func() bool { return out.contains("one") && out.contains("two") })

	p, out = spawn(t, config.Proc{ID: "cmd", Cmd: []string{"printf", "%s-%s", "a b", "c"}})
	<-p.Done()
	until(t, "argv kept intact", func() bool { return out.contains("a b-c") })
}

func TestEnvAndDir(t *testing.T) {
	dir := t.TempDir()
	out := &output{}
	p, err := Spawn(Options{
		Spec: config.Proc{ID: "env", Shell: `echo "$GREETING $TERM $(pwd -P)"`, Env: map[string]string{"GREETING": "hi"}},
		Dir:  dir, Cols: 80, Rows: 24, OnData: out.write,
	})
	if err != nil {
		t.Fatal(err)
	}
	<-p.Done()
	until(t, "env and cwd", func() bool { return out.contains("hi xterm-256color") && out.contains(dir[len(dir)-10:]) })
}

func TestExitCodes(t *testing.T) {
	p, _ := spawn(t, config.Proc{ID: "fail", Shell: "exit 3"})
	if exit := p.Exit(); exit.Code != 3 || exit.Signal != "" {
		t.Fatalf("exit = %+v", exit)
	}
	p, _ = spawn(t, config.Proc{ID: "killed", Cmd: []string{"sleep", "60"}})
	KillGroup(p.Pid, 15)
	if exit := p.Exit(); exit.Signal != "SIGTERM" {
		t.Fatalf("exit = %+v", exit)
	}
}

func TestMissingBinary(t *testing.T) {
	if _, err := Spawn(Options{Spec: config.Proc{ID: "x", Cmd: []string{"definitely-not-a-real-binary-xyz"}}, Dir: t.TempDir()}); err == nil {
		t.Fatal("spawning a missing binary succeeded")
	}
}

func TestTerminateKillsTheWholeTree(t *testing.T) {
	// The leader shell stays alive; a grandchild runs under the same group.
	p, _ := spawn(t, config.Proc{ID: "tree", Shell: "sleep 100 & sleep 60"})
	until(t, "group alive", func() bool { return GroupAlive(p.Pid) })
	p.Terminate(time.Second)
	until(t, "group dead", func() bool { return !GroupAlive(p.Pid) })
}

func TestTerminateEscalatesToSIGKILL(t *testing.T) {
	p, out := spawn(t, config.Proc{ID: "stubborn", Shell: `trap "echo ignoring" TERM; echo up; while true; do sleep 1; done`})
	until(t, "up", func() bool { return out.contains("up") })
	start := time.Now()
	p.Terminate(500 * time.Millisecond)
	until(t, "group dead", func() bool { return !GroupAlive(p.Pid) })
	if elapsed := time.Since(start); elapsed < 400*time.Millisecond {
		t.Errorf("SIGKILL came after %v, before the grace period", elapsed)
	}
}

func TestTerminateKillsSurvivorsOfTheLeader(t *testing.T) {
	// The leader exits on its own while a child that ignores SIGTERM and
	// SIGHUP keeps running in the group — the kernel sends SIGHUP to the
	// foreground group when the session leader dies, and a child honouring it
	// would leave no survivor to test against.
	p, out := spawn(t, config.Proc{ID: "orphan", Shell: `sh -c 'trap "" TERM HUP; echo child-up; while true; do sleep 1; done' & sleep 0.3`})
	until(t, "child-up", func() bool { return out.contains("child-up") })
	<-p.Done()
	if !GroupAlive(p.Pid) {
		t.Fatal("the group died with its leader; nothing left to test")
	}
	p.Terminate(500 * time.Millisecond)
	until(t, "group dead", func() bool { return !GroupAlive(p.Pid) })
}

func TestTerminateOnDeadTreeIsNoop(t *testing.T) {
	p, _ := spawn(t, config.Proc{ID: "gone", Shell: "true"})
	<-p.Done()
	until(t, "group dead", func() bool { return !GroupAlive(p.Pid) })
	p.Terminate(500 * time.Millisecond)
}

func TestCompletePrefix(t *testing.T) {
	word := []byte("héllo ✓")
	for cut := range len(word) + 1 {
		got := completePrefix(word[:cut])
		if got > cut || !strings.HasPrefix(string(word), string(word[:got])) {
			t.Fatalf("cut %d → %d", cut, got)
		}
		// Whatever is held back must be an incomplete rune, not ASCII.
		if rest := word[got:cut]; len(rest) > 0 && rest[0] < 0x80 {
			t.Fatalf("cut %d held back ASCII %q", cut, rest)
		}
	}
}
