// Package proc is the low-level PTY handling: spawn, signal delivery and
// process-tree teardown. The supervisor sits on top of it, so the tricky OS
// bits stay independently readable and testable.
package proc

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/creack/pty"
	"golang.org/x/sys/unix"

	"github.com/kondaurovDev/procdeck/internal/config"
)

// Exit is how a process ended.
type Exit struct {
	Code int
	// Signal names the signal that ended the process ("SIGTERM"), when one
	// did; Code is 0 then.
	Signal string
}

// Options describe one spawn.
type Options struct {
	// Spec is the proc with its templates already resolved.
	Spec config.Proc
	// Base sits between the inherited environment and the spec's own env —
	// the deck's env files.
	Base map[string]string
	Dir  string
	Cols uint16
	Rows uint16
	// OnData receives output as it arrives, split on rune boundaries. It is
	// called from a single goroutine per process.
	OnData func(data string)
}

// Proc is a running process tree behind a PTY.
type Proc struct {
	Pid int

	cmd     *exec.Cmd
	tty     *os.File
	writeMu sync.Mutex
	done    chan struct{}
	exit    Exit
}

// Describe is the human-readable command line, used as the UI subtitle.
func Describe(spec config.Proc) string {
	if spec.Shell != "" {
		return spec.Shell
	}
	return strings.Join(spec.Cmd, " ")
}

func argv(spec config.Proc) []string {
	if spec.Shell != "" {
		return []string{shell(), "-c", spec.Shell}
	}
	return spec.Cmd
}

func shell() string {
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	return "/bin/sh"
}

// inherited is procdeck's own environment with base on top.
// PROCDECK_DETACHED is procdeck's business, not the child's.
func inherited(base map[string]string) map[string]string {
	env := map[string]string{}
	for _, kv := range os.Environ() {
		if key, value, ok := strings.Cut(kv, "="); ok {
			env[key] = value
		}
	}
	delete(env, "PROCDECK_DETACHED")
	maps.Copy(env, base)
	return env
}

func pairs(env map[string]string) []string {
	out := make([]string, 0, len(env))
	for key, value := range env {
		out = append(out, key+"="+value)
	}
	slices.Sort(out)
	return out
}

// buildEnv layers, lowest first: the inherited environment, the deck's env
// files, terminal hints, the spec's own variables.
func buildEnv(base, extra map[string]string, dir string) []string {
	env := inherited(base)
	// A real PTY already implies a TTY, but some tools look at these directly.
	env["TERM"] = "xterm-256color"
	env["FORCE_COLOR"] = "1"
	maps.Copy(env, extra)
	env["PWD"] = dir
	return pairs(env)
}

// lookPath resolves argv[0] against the child's PATH, not procdeck's own: a
// spec's env may prepend tool directories.
func lookPath(file string, env []string) (string, error) {
	if strings.Contains(file, "/") {
		return file, nil
	}
	path := ""
	for _, kv := range env {
		if value, ok := strings.CutPrefix(kv, "PATH="); ok {
			path = value
		}
	}
	for _, dir := range filepath.SplitList(path) {
		if dir == "" {
			dir = "."
		}
		candidate := filepath.Join(dir, file)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("%s: command not found", file)
}

// Spawn starts the process in a new session with the PTY as its controlling
// terminal, so its pid doubles as the process group id.
func Spawn(o Options) (*Proc, error) {
	args := argv(o.Spec)
	if len(args) == 0 {
		return nil, fmt.Errorf("proc %q defines neither shell nor cmd", o.Spec.ID)
	}
	env := buildEnv(o.Base, o.Spec.Env, o.Dir)
	path, err := lookPath(args[0], env)
	if err != nil {
		return nil, err
	}
	cmd := &exec.Cmd{Path: path, Args: args, Env: env, Dir: o.Dir}
	tty, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: o.Cols, Rows: o.Rows})
	if err != nil {
		return nil, err
	}
	p := &Proc{Pid: cmd.Process.Pid, cmd: cmd, tty: tty, done: make(chan struct{})}
	drained := make(chan struct{})
	go p.read(o.OnData, drained)
	go p.wait(drained)
	return p, nil
}

func (p *Proc) read(onData func(string), drained chan<- struct{}) {
	defer close(drained)
	buf := make([]byte, 32*1024)
	var carry []byte
	for {
		n, err := p.tty.Read(buf)
		if n > 0 {
			data := append(carry, buf[:n]...)
			// A multi-byte rune split across reads waits for its tail.
			cut := completePrefix(data)
			carry = append([]byte(nil), data[cut:]...)
			if cut > 0 {
				onData(string(data[:cut]))
			}
		}
		if err != nil {
			if len(carry) > 0 {
				onData(string(carry))
			}
			return
		}
	}
}

// completePrefix is the length of b without a trailing incomplete rune.
func completePrefix(b []byte) int {
	for i := len(b) - 1; i >= 0 && i >= len(b)-utf8.UTFMax+1; i-- {
		if b[i] < utf8.RuneSelf {
			return len(b)
		}
		if utf8.RuneStart(b[i]) {
			if utf8.FullRune(b[i:]) {
				return len(b)
			}
			return i
		}
	}
	return len(b)
}

func (p *Proc) wait(drained <-chan struct{}) {
	p.cmd.Wait()
	exit := exitOf(p.cmd.ProcessState)
	// Output still in flight gets a moment to drain; a descendant holding the
	// terminal open must not keep the exit from being reported.
	select {
	case <-drained:
	case <-time.After(200 * time.Millisecond):
	}
	// Closing the master hangs up the terminal for whatever still holds it.
	p.tty.Close()
	p.exit = exit
	close(p.done)
}

func exitOf(state *os.ProcessState) Exit {
	if state == nil {
		return Exit{Code: -1}
	}
	if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
		name := unix.SignalName(status.Signal())
		if name == "" {
			name = fmt.Sprintf("signal %d", status.Signal())
		}
		return Exit{Signal: name}
	}
	return Exit{Code: state.ExitCode()}
}

// Done is closed once the process has exited and its output has drained.
func (p *Proc) Done() <-chan struct{} { return p.done }

// Exit reports how the process ended; valid once Done is closed.
func (p *Proc) Exit() Exit {
	<-p.done
	return p.exit
}

// Write types into the terminal.
func (p *Proc) Write(data string) {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	p.tty.Write([]byte(data))
}

// Resize changes the terminal size; the process gets SIGWINCH.
func (p *Proc) Resize(cols, rows uint16) {
	pty.Setsize(p.tty, &pty.Winsize{Cols: cols, Rows: rows})
}

const (
	preflightTimeout = 15 * time.Second
	preflightOutput  = 1 << 20
)

// Preflight runs a check: a plain (non-PTY) shell command with its output
// captured for the pane, stdout then stderr. It sees the inherited
// environment with base on top — not the spec's env. Exit 0 means "clear to
// spawn". A timeout counts as a failure — a preflight that hangs is a
// preflight that failed — and so does output past 1 MB.
func Preflight(ctx context.Context, command, dir string, base map[string]string) (ok bool, output string) {
	ctx, cancel := context.WithTimeout(ctx, preflightTimeout)
	defer cancel()
	var stdout, stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, shell(), "-c", command)
	cmd.Dir = dir
	cmd.Env = pairs(inherited(base))
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	// Its own group, so a timeout takes the whole check down, not just the
	// shell; WaitDelay stops a lingering grandchild from holding the pipes.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	output = stdout.String() + stderr.String()
	return err == nil && len(output) <= preflightOutput, output
}

// KillGroup signals the whole process group: the session leader's pid is the
// group id, so a negative pid reaches every descendant — pnpm → wrangler →
// workerd. Killing just the pid would leave grandchildren holding ports.
func KillGroup(pid int, sig syscall.Signal) {
	if syscall.Kill(-pid, sig) != nil {
		// No such group (already reaped, or never became a leader).
		syscall.Kill(pid, sig)
	}
}

// GroupAlive reports whether anything in the process group still runs —
// the leader may be gone while wrangler/workerd live on under the same pgid.
func GroupAlive(pid int) bool {
	alive := func(err error) bool { return err == nil || errors.Is(err, syscall.EPERM) }
	return alive(syscall.Kill(-pid, 0)) || alive(syscall.Kill(pid, 0))
}

// Terminate stops the tree: SIGTERM, a grace period, then SIGKILL for
// whatever is still standing.
func (p *Proc) Terminate(grace time.Duration) {
	if !GroupAlive(p.Pid) {
		return
	}
	KillGroup(p.Pid, syscall.SIGTERM)
	select {
	case <-p.done:
		// The leader exiting proves nothing about its descendants — workerd
		// may have ignored SIGTERM. Probe the whole group before declaring
		// victory.
		if !GroupAlive(p.Pid) {
			return
		}
	case <-time.After(grace):
	}
	KillGroup(p.Pid, syscall.SIGKILL)
	for i := 0; i < 10 && GroupAlive(p.Pid); i++ {
		time.Sleep(100 * time.Millisecond)
	}
}
