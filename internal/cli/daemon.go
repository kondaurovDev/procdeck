package cli

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/kondaurovDev/procdeck/internal/config"
	"github.com/kondaurovDev/procdeck/internal/deck"
	"github.com/kondaurovDev/procdeck/internal/registry"
)

// forceAfter separates a second Ctrl-C from an echo of the first: the
// terminal signals the whole foreground group, and a launcher in it (the npm
// shim) passes the same signal on a moment later.
const forceAfter = 250 * time.Millisecond

// runForeground serves the deck in this process until a signal. The first
// SIGINT/SIGTERM tears it down gracefully; a second one skips that.
func runForeground(loaded *config.Loaded) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)
	go func() {
		<-signals
		first := time.Now()
		cancel()
		for range signals {
			if time.Since(first) > forceAfter {
				os.Exit(1)
			}
		}
	}()

	mode := registry.Foreground
	if os.Getenv("PROCDECK_DETACHED") == "1" {
		mode = registry.Detached
	}
	err := deck.Run(ctx, loaded, mode)
	if errors.Is(err, deck.ErrInterrupted) {
		return &exitError{code: 130}
	}
	if err != nil {
		return fail("%s", err)
	}
	return nil
}

// detach re-runs procdeck as `up --fg` in its own session, with its output
// in a log file, and lets go of it. The child registers itself once it is
// listening; that registry entry is how the parent learns the deck came up —
// so `up` returns only when the UI is reachable, and a bad config or a busy
// port surfaces here, in the terminal.
func detach(configPath, root string) (registry.Instance, error) {
	if err := registry.EnsureHome(); err != nil {
		return registry.Instance{}, err
	}
	rotateLog(registry.LogPath(root))
	log, err := os.OpenFile(registry.LogPath(root), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return registry.Instance{}, err
	}
	defer log.Close()
	self, err := os.Executable()
	if err != nil {
		return registry.Instance{}, err
	}
	child := exec.Command(self, "up", "--fg", "--no-open", configPath)
	child.Dir = root
	child.Env = append(os.Environ(), "PROCDECK_DETACHED=1")
	child.Stdout, child.Stderr = log, log
	child.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := child.Start(); err != nil {
		return registry.Instance{}, err
	}
	exited := make(chan int, 1)
	go func() {
		child.Wait()
		exited <- child.ProcessState.ExitCode()
	}()

	deadline := time.After(20 * time.Second)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case code := <-exited:
			return registry.Instance{}, fmt.Errorf("procdeck exited with code %d%s", code, logTail(root, 15))
		case <-deadline:
			return registry.Instance{}, fmt.Errorf("procdeck did not come up in 20s%s", logTail(root, 15))
		case <-ticker.C:
			if instance, ok := registry.Find(root); ok && instance.Pid == child.Process.Pid {
				return instance, nil
			}
		}
	}
}

// logLimit is where a deck's log is set aside — every `up` appends to it.
const logLimit = 4 << 20

// rotateLog keeps one previous generation: past the limit the log becomes
// <log>.1 and the deck starts a fresh one.
func rotateLog(file string) {
	if info, err := os.Stat(file); err == nil && info.Size() > logLimit {
		os.Rename(file, file+".1")
	}
}

// shutdown stops a deck: SIGTERM — the same path as Ctrl-C, the deck tears
// every tree down, then deregisters — and waits for the process to be gone.
// Past the deadline it is SIGKILLed; its stale registry entry is pruned on
// the next read.
func shutdown(instance registry.Instance) (killed bool) {
	if syscall.Kill(instance.Pid, syscall.SIGTERM) != nil {
		return false
	}
	deadline := time.Now().Add(30 * time.Second)
	for registry.IsAlive(instance.Pid) {
		if time.Now().After(deadline) {
			syscall.Kill(instance.Pid, syscall.SIGKILL)
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

// openBrowser opens a URL in the default browser — best effort, never blocks.
func openBrowser(url string) {
	opener := "xdg-open"
	if runtime.GOOS == "darwin" {
		opener = "open"
	}
	cmd := exec.Command(opener, url)
	if cmd.Start() == nil {
		cmd.Process.Release()
	}
}

// isPortFree probes the bind the deck will do.
func isPortFree(port int, host string) bool {
	l, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return false
	}
	l.Close()
	return true
}

// logTail is the end of a deck's log for a terminal message.
func logTail(root string, n int) string {
	file := registry.LogPath(root)
	data, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	kept := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(kept) > n {
		kept = kept[len(kept)-n:]
	}
	if len(kept) == 0 {
		return ""
	}
	return fmt.Sprintf("\n  %s:\n  %s", pretty(file), strings.Join(kept, "\n  "))
}
