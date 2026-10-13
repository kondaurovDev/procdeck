// Package mcpserver is `procdeck mcp` — the deck's tools over the Model
// Context Protocol (stdio).
//
// A thin layer over the same HTTP API the CLI verbs use: every tool is a CLI
// verb, no new capability. What MCP adds is discoverability — the agent sees
// the tools and their descriptions without a CLAUDE.md line — so the
// descriptions carry the workflow ("call deck_status first", the mark → act →
// get_logs verify loop). Added once globally:
//
//	claude mcp add procdeck -- procdeck mcp
//
// and the instance registry resolves the right deck for whatever project the
// agent runs in (cwd → config walk → registry), per call — the server
// outlives deck restarts and can start before the deck is up.
//
// Read-only by default; --mutations also exposes restart/stop/start.
package mcpserver

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/kondaurovDev/procdeck/internal/config"
	"github.com/kondaurovDev/procdeck/internal/deckclient"
	"github.com/kondaurovDev/procdeck/internal/errscan"
	"github.com/kondaurovDev/procdeck/internal/httplog"
	"github.com/kondaurovDev/procdeck/internal/lines"
	"github.com/kondaurovDev/procdeck/internal/registry"
	"github.com/kondaurovDev/procdeck/internal/supervisor"
)

const errorsScanLines = 5000

// resolveDeck finds the deck for the working directory's project — per
// call, never cached.
func resolveDeck() (registry.Instance, error) {
	cwd, _ := os.Getwd()
	file := config.Locate(cwd)
	if file == "" {
		return registry.Instance{}, fmt.Errorf("no procdeck config found in or above %s", cwd)
	}
	root := filepath.Dir(file)
	if real, err := filepath.EvalSymlinks(root); err == nil {
		root = real
	}
	instance, ok := registry.Find(root)
	if !ok {
		return registry.Instance{}, fmt.Errorf("no deck is up for %s — run `procdeck up` there first", root)
	}
	return instance, nil
}

// session holds the "since my last call" cursors. One stdio process is one
// MCP session, so this state is exactly per client. Every get_logs answer
// advances logs (for the procs it covered); `since_last` reads from there.
// get_http keeps its own: the two streams have independent seq spaces.
type session struct {
	mu   sync.Mutex
	logs map[string]int
	http map[string]int
}

func (s *session) since(cursors map[string]int, use bool) map[string]int {
	if !use {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return maps.Clone(cursors)
}

func (s *session) advance(cursors, next map[string]int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	maps.Copy(cursors, next)
}

func sinceMs(seconds float64) int64 {
	if seconds <= 0 {
		return 0
	}
	return time.Now().Add(-time.Duration(seconds * float64(time.Second))).UnixMilli()
}

// tool registers a handler that runs against the resolved deck. Problems —
// the deck is down, an unknown proc — come back as tool errors the agent can
// read and act on, never as protocol errors.
func tool[In any](server *mcp.Server, t *mcp.Tool, run func(context.Context, registry.Instance, In) (any, error)) {
	mcp.AddTool(server, t, func(ctx context.Context, _ *mcp.CallToolRequest, in In) (*mcp.CallToolResult, any, error) {
		instance, err := resolveDeck()
		if err != nil {
			return nil, nil, err
		}
		out, err := run(ctx, instance, in)
		return nil, out, err
	})
}

var readOnly = &mcp.ToolAnnotations{ReadOnlyHint: true}

type noInput struct{}

type logsInput struct {
	Proc         string  `json:"proc,omitempty" jsonschema:"proc id, or several as csv (default: every proc)"`
	Lines        int     `json:"lines,omitempty" jsonschema:"max lines, the most recent (default 200, max 5000)"`
	Grep         string  `json:"grep,omitempty" jsonschema:"case-insensitive regexp the lines must match"`
	SinceSeconds float64 `json:"since_seconds,omitempty" jsonschema:"only lines newer than this many seconds"`
	SinceMark    string  `json:"since_mark,omitempty" jsonschema:"only lines after this mark (set_mark)"`
	SinceLast    bool    `json:"since_last,omitempty" jsonschema:"only lines after your previous get_logs call"`
}

type httpInput struct {
	Proc         string  `json:"proc,omitempty" jsonschema:"proc id, or several as csv (default: every proc)"`
	Limit        int     `json:"limit,omitempty" jsonschema:"max exchanges, the most recent (default 50, max 1000)"`
	Status       string  `json:"status,omitempty" jsonschema:"\"5xx\", \"422\" or \"error\" (4xx/5xx/refused)"`
	Path         string  `json:"path,omitempty" jsonschema:"case-insensitive regexp the path must match"`
	Kind         string  `json:"kind,omitempty" jsonschema:"\"http\" or \"ws\" (default: both)"`
	SinceSeconds float64 `json:"since_seconds,omitempty" jsonschema:"only exchanges newer than this many seconds"`
	SinceMark    string  `json:"since_mark,omitempty" jsonschema:"only exchanges after this mark (set_mark)"`
	SinceLast    bool    `json:"since_last,omitempty" jsonschema:"only exchanges after your previous get_http call"`
	Bodies       bool    `json:"bodies,omitempty" jsonschema:"include captured bodies, headers and ws message text"`
}

type timelineInput struct {
	AtMs          int64    `json:"at_ms,omitempty" jsonschema:"the moment, epoch ms (default: now)"`
	WindowSeconds float64  `json:"window_seconds,omitempty" jsonschema:"half-width of the window (default 10)"`
	Procs         []string `json:"procs,omitempty" jsonschema:"proc ids (default: every proc)"`
	Lines         int      `json:"lines,omitempty" jsonschema:"max lines (default 200)"`
}

type errorsInput struct {
	Proc         string  `json:"proc,omitempty" jsonschema:"proc id (default: every proc)"`
	SinceSeconds float64 `json:"since_seconds,omitempty" jsonschema:"only output newer than this many seconds"`
	SinceMark    string  `json:"since_mark,omitempty" jsonschema:"only output after this mark (set_mark)"`
}

type markInput struct {
	Name string `json:"name,omitempty" jsonschema:"mark name (default \"default\")"`
}

type waitInput struct {
	Proc           string  `json:"proc" jsonschema:"proc id to wait for"`
	Pattern        string  `json:"pattern,omitempty" jsonschema:"regexp an output line of the current run must match (default: a listening port)"`
	TimeoutSeconds float64 `json:"timeout_seconds,omitempty" jsonschema:"give up after this long (default 30)"`
}

type procInput struct {
	Proc string `json:"proc" jsonschema:"proc id"`
}

// waitResult is wait_for's answer: a success with a message, or a failure
// with its kind, reason and — for a crash — the last output lines.
type waitResult struct {
	OK             bool     `json:"ok"`
	Message        string   `json:"message,omitempty"`
	ElapsedSeconds float64  `json:"elapsedSeconds,omitempty"`
	Kind           string   `json:"kind,omitempty"`
	Reason         string   `json:"reason,omitempty"`
	Tail           []string `json:"tail,omitempty"`
}

// timelineResult is the lines around a moment plus the same window's
// traffic.
type timelineResult struct {
	lines.Result
	HTTP []httplog.Entry `json:"http"`
}

// New builds the server; mutations adds restart/stop/start.
func New(version string, mutations bool) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "procdeck", Version: version}, nil)
	s := &session{logs: map[string]int{}, http: map[string]int{}}

	tool(server, &mcp.Tool{
		Name:        "deck_status",
		Description: "Status of this project's procdeck deck (the dev-process manager): every process with state, ports, restarts and addresses, plus an `attention` list naming crashed / blocked / alerting procs with reasons. The cheapest question — call it first when anything seems broken, and before reading logs.",
		Annotations: readOnly,
	}, func(ctx context.Context, i registry.Instance, _ noInput) (any, error) {
		return deckclient.Status(ctx, i), nil
	})

	tool(server, &mcp.Tool{
		Name:        "get_logs",
		Description: "Recent output of the deck's processes as plain text lines (ANSI stripped, timestamped, interleaved across procs unless `proc` narrows it). Bounded on purpose: default 200 lines, max 5000, `omitted` says how many matching lines were dropped. Narrow with `grep` (case-insensitive regexp), `since_seconds`, `since_mark` (a mark you set), or `since_last: true` for only what arrived after your previous get_logs call in this session.",
		Annotations: readOnly,
	}, func(ctx context.Context, i registry.Instance, in logsInput) (any, error) {
		result, err := deckclient.Logs(ctx, i, deckclient.LogsParams{
			Proc: in.Proc, Lines: or(in.Lines, 200), Grep: in.Grep, SinceMs: sinceMs(in.SinceSeconds),
			Mark: in.SinceMark, SinceSeq: s.since(s.logs, in.SinceLast),
		})
		if err != nil {
			return nil, err
		}
		s.advance(s.logs, result.NextSeq)
		return result, nil
	})

	tool(server, &mcp.Tool{
		Name:        "get_http",
		Description: "HTTP traffic captured between the deck's processes and into them (via the *.localhost proxy and each proc's assigned `${port}`): method, path, status, duration and body sizes per exchange — plus WebSocket messages on the same connections (kind \"ws\": direction, size, text; a `connId` ties them to their status-101 upgrade). The verify loop's second half: set_mark → act → get_http with `since_mark` shows exactly which requests your action caused and what they returned — stronger evidence than log lines. Narrow with `status` (\"5xx\", \"422\", or \"error\"), `path` (regexp), `kind` (\"http\" | \"ws\"), `since_seconds`, `since_mark`, or `since_last: true` for only what arrived after your previous get_http call. Set `bodies: true` to include captured request/response bodies and ws message text (text only, truncated; auth headers always redacted). Blind spots: outbound calls to the internet and procs on hardcoded ports.",
		Annotations: readOnly,
	}, func(ctx context.Context, i registry.Instance, in httpInput) (any, error) {
		if in.Kind != "" && in.Kind != "http" && in.Kind != "ws" {
			return nil, fmt.Errorf(`kind must be "http" or "ws", got %q`, in.Kind)
		}
		result, err := deckclient.HTTP(ctx, i, deckclient.HTTPParams{
			Proc: in.Proc, Limit: or(in.Limit, 50), Status: in.Status, Path: in.Path, Kind: in.Kind,
			SinceMs: sinceMs(in.SinceSeconds), Mark: in.SinceMark, SinceSeq: s.since(s.http, in.SinceLast), Bodies: in.Bodies,
		})
		if err != nil {
			return nil, err
		}
		s.advance(s.http, result.NextSeq)
		return result, nil
	})

	tool(server, &mcp.Tool{
		Name:        "timeline",
		Description: "Interleaved output of several processes (default: all) around a moment in time, plus the HTTP exchanges captured in the same window — \"the frontend threw a 500 at T; what were api and worker doing right then, and which requests flew?\". `at_ms` is epoch milliseconds, same clock as every log line's `ts` and get_errors' lastTs (default: now). `window_seconds` (default 10) is the half-width.",
		Annotations: readOnly,
	}, func(ctx context.Context, i registry.Instance, in timelineInput) (any, error) {
		at := in.AtMs
		if at == 0 {
			at = time.Now().UnixMilli()
		}
		window := int64(or(in.WindowSeconds, 10) * 1000)
		procs := strings.Join(in.Procs, ",")
		logs, err := deckclient.Logs(ctx, i, deckclient.LogsParams{Proc: procs, Lines: or(in.Lines, 200), SinceMs: at - window, UntilMs: at + window})
		if err != nil {
			return nil, err
		}
		traffic, err := deckclient.HTTP(ctx, i, deckclient.HTTPParams{Proc: procs, Limit: 100, SinceMs: at - window, UntilMs: at + window})
		if err != nil {
			return nil, err
		}
		return timelineResult{Result: logs, HTTP: traffic.Exchanges}, nil
	})

	tool(server, &mcp.Tool{
		Name:        "get_errors",
		Description: "Errors parsed out of recent process output and deduplicated by signature — \"same TypeError, 41×, last seen 3s ago\" with one sample stack trace, instead of 41 raw traces. Heuristic (JS/Python/Go-ish); fall back to get_logs with `grep` when it misses something.",
		Annotations: readOnly,
	}, func(ctx context.Context, i registry.Instance, in errorsInput) (any, error) {
		result, err := deckclient.Logs(ctx, i, deckclient.LogsParams{
			Proc: in.Proc, Lines: errorsScanLines, SinceMs: sinceMs(in.SinceSeconds), Mark: in.SinceMark,
		})
		if err != nil {
			return nil, err
		}
		return map[string]any{"errors": errscan.Extract(result.Lines), "scannedLines": len(result.Lines)}, nil
	})

	tool(server, &mcp.Tool{
		Name:        "set_mark",
		Description: "Drop a named marker at \"now\" in every process's output stream. The verify loop: set_mark → act (edit, restart, hit an endpoint) → get_logs/get_errors with since_mark shows only what your action caused. Marks are in-memory and die with the deck; re-marking the same name moves it.",
		Annotations: &mcp.ToolAnnotations{IdempotentHint: true},
	}, func(ctx context.Context, i registry.Instance, in markInput) (any, error) {
		var mark supervisor.Mark
		err := deckclient.Post(ctx, i, "/marks", map[string]string{"name": or(in.Name, "default")}, &mark)
		return mark, err
	})

	tool(server, &mcp.Tool{
		Name:        "wait_for",
		Description: "Block until a process is ready: a listening port (default) or an output line matching `pattern` (regexp, matched against output of the current run — safe to call right after a restart). Fails fast with the last output lines if the process crashes instead of burning the timeout (default 30s). Use between restarting a process and exercising it.",
		Annotations: readOnly,
	}, func(ctx context.Context, i registry.Instance, in waitInput) (any, error) {
		timeout := time.Duration(or(in.TimeoutSeconds, 30) * float64(time.Second))
		outcome, err := deckclient.WaitFor(ctx, i, in.Proc, in.Pattern, timeout)
		if err != nil {
			return nil, err
		}
		return waitResult{
			OK: outcome.OK, Message: outcome.Message, ElapsedSeconds: outcome.Elapsed.Seconds(),
			Kind: outcome.Kind, Reason: outcome.Reason, Tail: outcome.Tail,
		}, nil
	})

	if mutations {
		for _, action := range []struct{ name, verb, description string }{
			{"restart_proc", "restart", "Restart one process of the deck by id (stop, then start). Follow with wait_for before exercising it."},
			{"stop_proc", "stop", "Stop one process of the deck by id (the whole process tree)."},
			{"start_proc", "start", "Start one stopped process of the deck by id."},
		} {
			tool(server, &mcp.Tool{Name: action.name, Description: action.description}, func(ctx context.Context, i registry.Instance, in procInput) (any, error) {
				var answer map[string]any
				err := deckclient.Post(ctx, i, "/procs/"+url.PathEscape(in.Proc)+"/"+action.verb, struct{}{}, &answer)
				return answer, err
			})
		}
	}
	return server
}

// or is value, or fallback when value is the zero value.
func or[T comparable](value, fallback T) T {
	var zero T
	if value == zero {
		return fallback
	}
	return value
}

// Run serves MCP over stdin/stdout until the client hangs up. Stdout belongs
// to the protocol from here on.
func Run(ctx context.Context, version string, mutations bool) error {
	err := New(version, mutations).Run(ctx, &mcp.StdioTransport{})
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}
