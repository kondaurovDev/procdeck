// Package deckclient asks a running deck over its HTTP API — shared by the
// CLI commands and the MCP server. One implementation of "ask the deck", two
// front doors.
package deckclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/kondaurovDev/procdeck/internal/httplog"
	"github.com/kondaurovDev/procdeck/internal/lines"
	"github.com/kondaurovDev/procdeck/internal/registry"
	"github.com/kondaurovDev/procdeck/internal/supervisor"
)

var client = &http.Client{Timeout: 5 * time.Second}

// URL is where a deck's UI answers.
func URL(i registry.Instance) string { return fmt.Sprintf("http://localhost:%d", i.Port) }

// Get calls the deck's API; a 4xx `{error}` body becomes the error message.
func Get(ctx context.Context, i registry.Instance, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, URL(i)+"/__procdeck/api"+path, nil)
	if err != nil {
		return err
	}
	return do(req, out)
}

// Post sends a JSON body to the deck's API.
func Post(ctx context.Context, i registry.Instance, path string, body, out any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, URL(i)+"/__procdeck/api"+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return do(req, out)
}

func do(req *http.Request, out any) error {
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		var failure struct {
			Error string `json:"error"`
		}
		if json.NewDecoder(res.Body).Decode(&failure) == nil && failure.Error != "" {
			return errors.New(failure.Error)
		}
		return fmt.Errorf("deck answered HTTP %d", res.StatusCode)
	}
	if out == nil {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// Procs lists the deck's procs; ok is false when the deck does not answer.
func Procs(ctx context.Context, i registry.Instance) (procs []supervisor.Info, ok bool) {
	if err := Get(ctx, i, "/procs", &procs); err != nil {
		return nil, false
	}
	return procs, true
}

// DescribeProc is a proc's state in a few words.
func DescribeProc(info supervisor.Info) string {
	st := info.Status
	switch st.State {
	case supervisor.Running:
		if st.Restarts > 0 {
			return fmt.Sprintf("running ↻%d", st.Restarts)
		}
		return "running"
	case supervisor.Exited:
		if st.Signal != "" {
			return fmt.Sprintf("killed (%s)", st.Signal)
		}
		if st.ExitCode == nil {
			return "exit ?"
		}
		return fmt.Sprintf("exit %d", *st.ExitCode)
	default:
		return string(st.State)
	}
}

// AttentionOf says why a proc deserves a look, if it does — the CLI/MCP twin
// of the UI badge.
func AttentionOf(info supervisor.Info) string {
	st := info.Status
	switch {
	case st.State == supervisor.Blocked && st.Hint != "":
		return "blocked — " + st.Hint
	case st.State == supervisor.Blocked:
		return "blocked"
	case st.Alert != "":
		return "alert: " + st.Alert
	case st.State == supervisor.Exited && (st.Signal != "" || (st.ExitCode != nil && *st.ExitCode != 0)):
		return DescribeProc(info)
	}
	return ""
}

// Attention is one proc that deserves a look.
type Attention struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

// StatusReport is `status --json` and the `deck_status` MCP tool — an
// agent's first question.
type StatusReport struct {
	Up        bool          `json:"up"`
	Name      string        `json:"name"`
	Root      string        `json:"root"`
	URL       string        `json:"url"`
	Pid       int           `json:"pid"`
	Version   string        `json:"version"`
	Mode      registry.Mode `json:"mode"`
	StartedAt int64         `json:"startedAt"`
	// Attention lists the procs that deserve a look right now — crashed,
	// blocked, alerting.
	Attention []Attention `json:"attention"`
	// Procs is null when the deck does not answer.
	Procs []supervisor.Info `json:"procs"`
}

// Status builds the report for a running deck.
func Status(ctx context.Context, i registry.Instance) StatusReport {
	report := StatusReport{
		Up: true, Name: i.Name, Root: i.Root, URL: URL(i), Pid: i.Pid,
		Version: i.Version, Mode: i.Mode, StartedAt: i.StartedAt, Attention: []Attention{},
	}
	if procs, ok := Procs(ctx, i); ok {
		report.Procs = procs
		for _, info := range procs {
			if reason := AttentionOf(info); reason != "" {
				report.Attention = append(report.Attention, Attention{ID: info.ID, Reason: reason})
			}
		}
	}
	return report
}

// LogsParams is the one spelling of a /logs query.
type LogsParams struct {
	// Proc is an id, or several as csv; empty means every proc.
	Proc    string
	Lines   int
	Grep    string
	SinceMs int64
	UntilMs int64
	Mark    string
	// SinceSeq holds per-proc resume cursors (a previous answer's nextSeq).
	SinceSeq map[string]int
}

func (p LogsParams) Encode() string {
	q := url.Values{}
	if p.Proc != "" {
		q.Set("procs", p.Proc)
	}
	q.Set("lines", strconv.Itoa(p.Lines))
	if p.Grep != "" {
		q.Set("grep", p.Grep)
	}
	if p.SinceMs != 0 {
		q.Set("sinceMs", strconv.FormatInt(p.SinceMs, 10))
	}
	if p.UntilMs != 0 {
		q.Set("untilMs", strconv.FormatInt(p.UntilMs, 10))
	}
	if p.Mark != "" {
		q.Set("mark", p.Mark)
	}
	if len(p.SinceSeq) > 0 {
		cursors, _ := json.Marshal(p.SinceSeq)
		q.Set("sinceSeq", string(cursors))
	}
	return q.Encode()
}

// Logs queries the deck's line buffers.
func Logs(ctx context.Context, i registry.Instance, p LogsParams) (lines.Result, error) {
	var result lines.Result
	err := Get(ctx, i, "/logs?"+p.Encode(), &result)
	return result, err
}

// HTTPParams is the one spelling of an /http query.
type HTTPParams struct {
	// Proc is an id, or several as csv; empty means every proc.
	Proc  string
	Limit int
	// Status is "5xx", "422" or "error".
	Status string
	// Path is a regexp matched against the path.
	Path    string
	SinceMs int64
	UntilMs int64
	Mark    string
	// SinceSeq holds per-proc resume cursors (a previous answer's nextSeq).
	SinceSeq map[string]int
	// Kind is "http" or "ws"; empty means both.
	Kind string
	// Bodies includes captured bodies, headers and ws message text.
	Bodies bool
}

func (p HTTPParams) Encode() string {
	q := url.Values{}
	if p.Proc != "" {
		q.Set("procs", p.Proc)
	}
	q.Set("limit", strconv.Itoa(p.Limit))
	for key, value := range map[string]string{"status": p.Status, "path": p.Path, "mark": p.Mark, "kind": p.Kind} {
		if value != "" {
			q.Set(key, value)
		}
	}
	if p.SinceMs != 0 {
		q.Set("sinceMs", strconv.FormatInt(p.SinceMs, 10))
	}
	if p.UntilMs != 0 {
		q.Set("untilMs", strconv.FormatInt(p.UntilMs, 10))
	}
	if len(p.SinceSeq) > 0 {
		cursors, _ := json.Marshal(p.SinceSeq)
		q.Set("sinceSeq", string(cursors))
	}
	if p.Bodies {
		q.Set("bodies", "1")
	}
	return q.Encode()
}

// HTTP queries the deck's captured traffic.
func HTTP(ctx context.Context, i registry.Instance, p HTTPParams) (httplog.Result, error) {
	var result httplog.Result
	err := Get(ctx, i, "/http?"+p.Encode(), &result)
	return result, err
}

// WaitOutcome is how a wait ended.
type WaitOutcome struct {
	OK      bool
	Message string
	Elapsed time.Duration
	// Kind is "crashed", "blocked", "stopped" or "timeout" when not OK.
	Kind   string
	Reason string
	// Tail holds the last output lines when the proc crashed — the "why",
	// right there.
	Tail []string
}

// WaitFor blocks until a proc is ready: a listening port, or an output line
// matching pattern. It fails fast when the proc crashes or is blocked instead
// of burning the timeout. Pattern searches start at the current run's first
// line, so `restart` + `wait-for` cannot lose a line that lands in between;
// after the first poll a seq cursor takes over.
func WaitFor(ctx context.Context, i registry.Instance, proc, pattern string, timeout time.Duration) (WaitOutcome, error) {
	const poll = 300 * time.Millisecond
	started := time.Now()
	elapsed := func() string { return fmt.Sprintf("%.1fs", time.Since(started).Seconds()) }
	cursor := -1
	stoppedPolls := 0

	for {
		var procs []supervisor.Info
		if err := Get(ctx, i, "/procs", &procs); err != nil {
			return WaitOutcome{}, err
		}
		var info *supervisor.Info
		for k := range procs {
			if procs[k].ID == proc {
				info = &procs[k]
			}
		}
		if info == nil {
			return WaitOutcome{}, fmt.Errorf("unknown proc %q", proc)
		}
		st := info.Status

		switch st.State {
		case supervisor.Exited:
			tail, err := Logs(ctx, i, LogsParams{Proc: proc, Lines: 20})
			if err != nil {
				return WaitOutcome{}, err
			}
			outcome := WaitOutcome{Kind: "crashed", Reason: fmt.Sprintf("%q %s after %s", proc, DescribeProc(*info), elapsed())}
			for _, line := range tail.Lines {
				outcome.Tail = append(outcome.Tail, line.Text)
			}
			return outcome, nil
		case supervisor.Blocked:
			reason := fmt.Sprintf("%q is blocked", proc)
			if st.Hint != "" {
				reason += " — " + st.Hint
			}
			return WaitOutcome{Kind: "blocked", Reason: reason}, nil
		}
		// A brief "stopped" can be the middle of a restart; a persistent one
		// means nobody is starting it — fail rather than burn the timeout.
		if st.State == supervisor.Stopped {
			stoppedPolls++
		} else {
			stoppedPolls = 0
		}
		if stoppedPolls >= 4 {
			return WaitOutcome{Kind: "stopped", Reason: fmt.Sprintf("%q is stopped and nothing is starting it", proc)}, nil
		}

		if pattern != "" {
			params := LogsParams{Proc: proc, Grep: pattern, Lines: 5}
			switch {
			case cursor >= 0:
				params.SinceSeq = map[string]int{proc: cursor}
			case st.StartedAt != 0:
				params.SinceMs = st.StartedAt
			default:
				params.SinceMs = started.UnixMilli()
			}
			result, err := Logs(ctx, i, params)
			if err != nil {
				return WaitOutcome{}, err
			}
			if len(result.Lines) > 0 {
				return WaitOutcome{
					OK:      true,
					Message: fmt.Sprintf("%q matched /%s/ in %s: %s", proc, pattern, elapsed(), result.Lines[0].Text),
					Elapsed: time.Since(started),
				}, nil
			}
			if next, ok := result.NextSeq[proc]; ok {
				cursor = next
			}
		} else if len(st.Ports) > 0 {
			return WaitOutcome{
				OK:      true,
				Message: fmt.Sprintf("%q is listening on :%d (%s)", proc, st.Ports[0], elapsed()),
				Elapsed: time.Since(started),
			}, nil
		}

		if time.Since(started) >= timeout {
			goal := "listen on a port"
			if pattern != "" {
				goal = fmt.Sprintf("match /%s/", pattern)
			}
			return WaitOutcome{
				Kind:   "timeout",
				Reason: fmt.Sprintf("timed out after %ds waiting for %q to %s", int(timeout.Round(time.Second).Seconds()), proc, goal),
			}, nil
		}
		select {
		case <-ctx.Done():
			return WaitOutcome{}, ctx.Err()
		case <-time.After(poll):
		}
	}
}
