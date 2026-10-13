package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/kondaurovDev/procdeck/internal/deckclient"
	"github.com/kondaurovDev/procdeck/internal/discover"
	"github.com/kondaurovDev/procdeck/internal/errscan"
	"github.com/kondaurovDev/procdeck/internal/lines"
	"github.com/kondaurovDev/procdeck/internal/registry"
	"github.com/kondaurovDev/procdeck/internal/supervisor"
)

// interruptible is a context that ends on Ctrl-C, for commands that wait.
func interruptible(ctx context.Context) (context.Context, context.CancelFunc) {
	return signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
}

// logsQuery assembles the /logs query shared by `logs` and `errors`.
func logsQuery(proc string, lines int, grep, since, sinceMark string) (deckclient.LogsParams, error) {
	params := deckclient.LogsParams{Proc: proc, Lines: lines, Grep: grep, Mark: sinceMark}
	if since != "" {
		window, ok := parseDuration(since)
		if !ok {
			return params, fail("bad --since %q — try 30s, 5m, 2h", since)
		}
		params.SinceMs = time.Now().Add(-window).UnixMilli()
	}
	return params, nil
}

func logsCmd() *cobra.Command {
	var lines int
	var grep, since, sinceMark string
	var asJSON, self, follow bool
	cmd := &cobra.Command{
		Use:   "logs [proc]",
		Short: "Recent output of the deck's processes",
		Long:  "Recent output of the deck's processes: plain lines, filterable and bounded — made for agents as much as for humans. `--self` is procdeck's own daemon log.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if self {
				return selfLogs(cmd.Context(), follow)
			}
			if follow && asJSON {
				return fail("--follow prints lines as they come; --json is for one answer")
			}
			instance, err := requireInstance("")
			if err != nil {
				return err
			}
			proc := firstArg(args)
			params, err := logsQuery(proc, lines, grep, since, sinceMark)
			if err != nil {
				return err
			}
			result, err := deckclient.Logs(cmd.Context(), instance, params)
			if err != nil {
				return fail("%s", err)
			}
			if follow {
				return followLogs(cmd.Context(), instance, params, result)
			}
			if asJSON {
				data, _ := json.Marshal(result)
				fmt.Println(string(data))
				return nil
			}
			if len(result.Lines) == 0 {
				fmt.Fprintln(os.Stderr, "procdeck: no matching lines in the buffer")
				return nil
			}
			if result.Omitted > 0 {
				fmt.Printf("… %d earlier matching lines omitted (raise --lines)\n", result.Omitted)
			}
			printLines(result, proc == "")
			return nil
		},
	}
	flags := cmd.Flags()
	flags.IntVarP(&lines, "lines", "n", 200, "max lines — the most recent ones (max 5000)")
	flags.StringVar(&grep, "grep", "", "only lines matching this regexp (case-insensitive)")
	flags.StringVar(&since, "since", "", "only lines newer than this — 30s, 5m, 2h")
	flags.StringVar(&sinceMark, "since-mark", "", "only lines after `procdeck mark <name>` was set")
	flags.BoolVar(&asJSON, "json", false, "machine-readable output (for agents and scripts)")
	flags.BoolVar(&self, "self", false, "procdeck's own daemon log instead of pane output")
	flags.BoolVarP(&follow, "follow", "f", false, "keep printing new lines as they arrive")
	return cmd
}

func printLines(result lines.Result, multi bool) {
	for _, line := range result.Lines {
		if multi {
			fmt.Printf("[%s] %s\n", line.Proc, line.Text)
		} else {
			fmt.Println(line.Text)
		}
	}
}

// followLogs prints the tail it was handed, then keeps asking the deck for
// what came after it. The seq cursors make that exact — no line twice, none
// lost — and a poll every 300 ms is all a terminal tail needs.
func followLogs(ctx context.Context, instance registry.Instance, params deckclient.LogsParams, first lines.Result) error {
	ctx, stop := interruptible(ctx)
	defer stop()
	multi := params.Proc == "" || strings.Contains(params.Proc, ",")
	printLines(first, multi)
	params.Mark, params.SinceMs, params.Lines = "", 0, 5000
	params.SinceSeq = first.NextSeq
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
		result, err := deckclient.Logs(ctx, instance, params)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			return fail("the deck stopped answering: %s", err)
		}
		if result.Omitted > 0 {
			fmt.Printf("… %d lines went by faster than this tail\n", result.Omitted)
		}
		printLines(result, multi)
		params.SinceSeq = result.NextSeq
	}
}

// selfLogs prints the deck's own daemon log, and with follow keeps printing
// what is appended — polling, which is portable, and the file only grows.
func selfLogs(ctx context.Context, follow bool) error {
	root, err := resolveRoot("")
	if err != nil {
		return err
	}
	file := registry.LogPath(root)
	data, err := os.ReadFile(file)
	if err != nil {
		return fail("no log yet for %s (%s)", pretty(root), pretty(file))
	}
	all := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	fmt.Println(strings.Join(all[max(0, len(all)-200):], "\n"))
	if !follow {
		return nil
	}
	ctx, stop := interruptible(ctx)
	defer stop()
	offset := int64(len(data))
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
		info, err := os.Stat(file)
		if err != nil {
			continue
		}
		if info.Size() < offset {
			offset = 0 // truncated
		}
		if info.Size() == offset {
			continue
		}
		f, err := os.Open(file)
		if err != nil {
			continue
		}
		f.Seek(offset, io.SeekStart)
		written, _ := io.Copy(os.Stdout, f)
		f.Close()
		offset += written
	}
}

func markCmd() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "mark [name]",
		Short: "Drop a named marker at \"now\" in every proc's output",
		Long:  `Drop a named marker at "now" in every proc's output. The verify loop: mark → act (restart, hit an endpoint) → ` + "`logs --since-mark`" + ` shows only what your action caused.`,
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := firstArg(args)
			if name == "" {
				name = "default"
			}
			instance, err := requireInstance("")
			if err != nil {
				return err
			}
			var mark supervisor.Mark
			if err := deckclient.Post(cmd.Context(), instance, "/marks", map[string]string{"name": name}, &mark); err != nil {
				return fail("%s", err)
			}
			if asJSON {
				data, _ := json.Marshal(mark)
				fmt.Println(string(data))
				return nil
			}
			fmt.Printf("procdeck: mark %q set — read what happens next with `procdeck logs --since-mark %s`\n", mark.Name, mark.Name)
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "machine-readable output (for agents and scripts)")
	return cmd
}

func waitForCmd() *cobra.Command {
	var pattern, timeout string
	cmd := &cobra.Command{
		Use:   "wait-for <proc>",
		Short: "Block until a proc listens or prints a matching line",
		Long:  "Block until a proc is ready: a listening port (default) or an output line matching --pattern. Fails fast if it crashes instead (exit 1); exit 2 on timeout. The `restart`-then-verify step for agents and scripts.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			instance, err := requireInstance("")
			if err != nil {
				return err
			}
			limit, ok := parseDuration(timeout)
			if !ok {
				return fail("bad --timeout %q — try 30s, 5m", timeout)
			}
			ctx, stop := interruptible(cmd.Context())
			defer stop()
			outcome, err := deckclient.WaitFor(ctx, instance, args[0], pattern, limit)
			if errors.Is(err, context.Canceled) {
				return &exitError{code: 130}
			}
			if err != nil {
				return fail("%s", err)
			}
			if outcome.OK {
				fmt.Printf("procdeck: %s\n", outcome.Message)
				return nil
			}
			for _, line := range outcome.Tail {
				fmt.Fprintf(os.Stderr, "  %s\n", line)
			}
			code, reason := 1, outcome.Reason
			if outcome.Kind == "crashed" {
				reason += " — last lines above"
			}
			if outcome.Kind == "timeout" {
				code = 2
			}
			return &exitError{code: code, msg: reason}
		},
	}
	cmd.Flags().StringVar(&pattern, "pattern", "", "succeed when this regexp matches a new output line (default: wait for a listening port)")
	cmd.Flags().StringVar(&timeout, "timeout", "30s", "give up after this long (exit code 2)")
	return cmd
}

const (
	errorsScanLines = 5000
	sampleShown     = 8
)

func errorsCmd() *cobra.Command {
	var since, sinceMark string
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "errors [proc]",
		Short: "Recent errors, parsed and deduplicated",
		Long:  `Recent errors, parsed out of the output and deduplicated — "same TypeError, 41×, last 3s ago" instead of 41 stack traces. Heuristic, so ` + "`logs --grep`" + ` remains the fallback.`,
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			instance, err := requireInstance("")
			if err != nil {
				return err
			}
			params, err := logsQuery(firstArg(args), errorsScanLines, "", since, sinceMark)
			if err != nil {
				return err
			}
			result, err := deckclient.Logs(cmd.Context(), instance, params)
			if err != nil {
				return fail("%s", err)
			}
			groups := errscan.Extract(result.Lines)
			if asJSON {
				data, _ := json.Marshal(map[string]any{"errors": groups, "scannedLines": len(result.Lines)})
				fmt.Println(string(data))
				return nil
			}
			if len(groups) == 0 {
				tail := ""
				if result.Omitted > 0 {
					tail = " (buffer tail)"
				}
				fmt.Printf("procdeck: no errors found in %d lines%s\n", len(result.Lines), tail)
				return nil
			}
			blocks := make([]string, len(groups))
			for i, group := range groups {
				blocks[i] = renderErrorGroup(group)
			}
			fmt.Println(strings.Join(blocks, "\n\n"))
			return nil
		},
	}
	cmd.Flags().StringVar(&since, "since", "", "only output newer than this — 30s, 5m, 2h")
	cmd.Flags().StringVar(&sinceMark, "since-mark", "", "only output after `procdeck mark <name>` was set")
	cmd.Flags().BoolVar(&asJSON, "json", false, "machine-readable output (for agents and scripts)")
	return cmd
}

func renderErrorGroup(group errscan.Group) string {
	head := fmt.Sprintf("[%s] %d× · last %s ago", group.Proc, group.Count, describeUptime(group.LastTS))
	if group.Count > 1 {
		head += fmt.Sprintf(" · first %s ago", describeUptime(group.FirstTS))
	}
	out := []string{head}
	for _, line := range group.Sample[:min(len(group.Sample), sampleShown)] {
		out = append(out, "  "+line)
	}
	if more := len(group.Sample) - sampleShown; more > 0 {
		out = append(out, fmt.Sprintf("  … +%d more lines (`procdeck logs %s`)", more, group.Proc))
	}
	return strings.Join(out, "\n")
}

func agentsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "agents",
		Short: "Introduce the deck to coding agents",
		Long:  `Introduce the deck to coding agents: a "## procdeck" section in CLAUDE.md / AGENTS.md (created if absent) and a Claude Code skill teaching the mark → act → since-mark verify loop. Idempotent.`,
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			configPath, err := resolveConfig("")
			if err != nil {
				return err
			}
			actions, err := discover.SetupAgents(filepath.Dir(configPath))
			if err != nil {
				return fail("%s", err)
			}
			fmt.Println("procdeck: introducing the deck to coding agents")
			for _, action := range actions {
				fmt.Println("  " + action)
			}
			fmt.Println("tip:  `claude mcp add procdeck -- procdeck mcp` adds the MCP tools in every procdeck project at once")
			return nil
		},
	}
}
