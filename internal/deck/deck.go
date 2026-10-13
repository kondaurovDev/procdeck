// Package deck runs one deck in this process: it binds the UI port, starts
// the supervisor, serves the API, registers the instance and tears it all
// down again — `procdeck up --fg`, and what a detached `up` runs in the
// background.
package deck

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"syscall"
	"time"

	"github.com/kondaurovDev/procdeck/internal/config"
	"github.com/kondaurovDev/procdeck/internal/registry"
	"github.com/kondaurovDev/procdeck/internal/server"
	"github.com/kondaurovDev/procdeck/internal/supervisor"
	"github.com/kondaurovDev/procdeck/internal/version"
	"github.com/kondaurovDev/procdeck/internal/webui"
)

// ErrInterrupted reports a deck ended by a signal (or the UI's Shutdown,
// which goes through the same path).
var ErrInterrupted = errors.New("interrupted")

// Logf prints one timestamped line of the deck's own log.
func Logf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[%s] %s\n", time.Now().Format("15:04:05.000"), fmt.Sprintf(format, args...))
}

// Run serves the deck until ctx is cancelled. Teardown runs in reverse:
// deregister, close the server, terminate every process tree.
func Run(ctx context.Context, loaded *config.Loaded, mode registry.Mode) error {
	port, host := loaded.Config.UIPort(), loaded.Config.UIHost()
	// Bind before spawning anything: a busy port must not cost a full stack
	// start and teardown.
	listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return explainListenError(err, port, loaded.Root)
	}

	sup, err := supervisor.Start(loaded)
	if err != nil {
		listener.Close()
		return err
	}
	defer sup.Close()

	handler := server.Handler(sup,
		server.Deck{Name: loaded.Name, Root: loaded.Root, Port: port, Version: version.Version},
		server.Hooks{
			// The same path as Ctrl-C and `procdeck down`.
			Shutdown:  func() { syscall.Kill(os.Getpid(), syscall.SIGTERM) },
			Instances: registry.List,
		},
		webui.FS(),
	)
	srv := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go srv.Serve(listener)
	defer srv.Close()

	id := registry.ID(loaded.Root)
	err = registry.Register(registry.Instance{
		ID:        id,
		Name:      loaded.Name,
		Root:      loaded.Root,
		Config:    loaded.File,
		Port:      port,
		Pid:       os.Getpid(),
		Log:       registry.LogPath(loaded.Root),
		StartedAt: time.Now().UnixMilli(),
		Version:   version.Version,
		Mode:      mode,
	})
	if err != nil {
		return fmt.Errorf("registering the deck: %w", err)
	}
	defer registry.Deregister(id, os.Getpid())

	bound := ""
	if host != config.DefaultUIHost {
		bound = " (bound to " + host + ")"
	}
	Logf("procdeck %s %q listening on http://localhost:%d%s (pid %d, %s)", version.Version, loaded.Name, port, bound, os.Getpid(), mode)

	<-ctx.Done()
	// Terminating every tree takes up to the SIGTERM grace period — say so,
	// or the pause reads as a hang.
	Logf("shutting down, terminating processes… (Ctrl-C again to force)")
	return ErrInterrupted
}

func explainListenError(err error, port int, root string) error {
	if !errors.Is(err, syscall.EADDRINUSE) {
		return err
	}
	who := "something else"
	if holder, ok := registry.FindByPort(port); ok {
		if holder.Root == root {
			who = "another procdeck for this project (stale? try `procdeck down`)"
		} else {
			who = fmt.Sprintf("deck %q (%s)", holder.Name, holder.Root)
		}
	}
	return fmt.Errorf("port %d is taken by %s — set \"port\" in the config, or `procdeck down` there", port, who)
}
