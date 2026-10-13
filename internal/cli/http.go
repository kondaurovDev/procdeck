package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/kondaurovDev/procdeck/internal/deckclient"
	"github.com/kondaurovDev/procdeck/internal/httplog"
)

const (
	defaultHTTPLimit = 50
	// digestScan is the whole ring rather than a tail — the server caps at
	// 1000.
	digestScan = 1000
)

func httpCmd() *cobra.Command {
	var limit int
	var status, path, since, sinceMark string
	var ws, body, digest, asJSON bool
	cmd := &cobra.Command{
		Use:   "http [proc]",
		Short: "HTTP traffic captured between and into the deck's processes",
		Long:  "HTTP traffic captured between and into the deck's processes: method, path, status, duration — and WebSocket messages on the same connections (`--ws`). The business data, not just the logs. `--digest` groups 4xx/5xx by route; the mark → act → `http --since-mark` loop shows exactly which requests a change caused.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			instance, err := requireInstance("")
			if err != nil {
				return err
			}
			proc := firstArg(args)
			params := deckclient.HTTPParams{Proc: proc, Limit: limit, Status: status, Path: path, Mark: sinceMark, Bodies: body}
			if digest {
				params.Limit, params.Status = digestScan, ""
			}
			if ws {
				params.Kind = "ws"
			}
			if since != "" {
				window, ok := parseDuration(since)
				if !ok {
					return fail("bad --since %q — try 30s, 5m, 2h", since)
				}
				params.SinceMs = time.Now().Add(-window).UnixMilli()
			}
			result, err := deckclient.HTTP(cmd.Context(), instance, params)
			if err != nil {
				return fail("%s", err)
			}

			if digest {
				groups := httplog.Digest(result.Exchanges)
				if asJSON {
					data, _ := json.Marshal(map[string]any{"digest": groups, "scannedExchanges": len(result.Exchanges)})
					fmt.Println(string(data))
					return nil
				}
				if len(groups) == 0 {
					fmt.Printf("procdeck: no failing requests among %d captured exchanges\n", len(result.Exchanges))
					return nil
				}
				for _, group := range groups {
					fmt.Println(renderDigest(group))
				}
				return nil
			}

			if asJSON {
				data, _ := json.Marshal(result)
				fmt.Println(string(data))
				return nil
			}
			if len(result.Exchanges) == 0 {
				fmt.Fprintln(os.Stderr, "procdeck: no captured exchanges — traffic is seen on the *.localhost addresses and on assigned ports (${port})")
				return nil
			}
			if result.Omitted > 0 {
				fmt.Printf("… %d earlier matching exchanges omitted (raise --limit)\n", result.Omitted)
			}
			for _, exchange := range result.Exchanges {
				fmt.Println(renderExchange(exchange, proc == "", body))
			}
			return nil
		},
	}
	flags := cmd.Flags()
	flags.IntVarP(&limit, "limit", "n", defaultHTTPLimit, "max exchanges — the most recent ones (max 1000)")
	flags.StringVar(&status, "status", "", `only this status: "5xx", "422", or "error" (4xx/5xx/refused)`)
	flags.StringVar(&path, "path", "", "only paths matching this regexp (case-insensitive)")
	flags.StringVar(&since, "since", "", "only exchanges newer than this — 30s, 5m, 2h")
	flags.StringVar(&sinceMark, "since-mark", "", "only exchanges after `procdeck mark <name>` was set")
	flags.BoolVar(&ws, "ws", false, "only WebSocket messages (default: http and ws interleaved)")
	flags.BoolVar(&body, "body", false, "include captured request/response bodies and ws message text")
	flags.BoolVar(&digest, "digest", false, "4xx/5xx grouped by route with counts — the errors view for traffic")
	flags.BoolVar(&asJSON, "json", false, "machine-readable output (for agents and scripts)")
	return cmd
}

func size(bytes int64) string {
	if bytes < 1024 {
		return fmt.Sprintf("%dB", bytes)
	}
	return fmt.Sprintf("%.1fkB", float64(bytes)/1024)
}

func clock(ts int64) string { return time.UnixMilli(ts).Format("15:04:05.000") }

func indented(label, text string) string {
	return fmt.Sprintf("  %s: %s", label, strings.ReplaceAll(text, "\n", "\n  "))
}

func renderExchange(e httplog.Entry, multi, bodies bool) string {
	who := ""
	if multi {
		who = "[" + e.Proc + "] "
	}
	if e.IsWS() {
		// "→" flows into the proc (client → server), "←" out of it.
		arrow := "←"
		if e.Dir == "in" {
			arrow = "→"
		}
		head := fmt.Sprintf("%s %sws%s %s %s %s #%d", clock(e.TS), who, arrow, e.Path, e.Opcode, size(e.Size), e.ConnID)
		if bodies && e.Text != "" {
			return head + "\n" + indented("msg", e.Text)
		}
		return head
	}
	status := strconv.Itoa(e.Status)
	if e.Status == 0 {
		status = "refused"
	}
	lines := []string{fmt.Sprintf("%s %s%s %s → %s %dms %s", clock(e.TS), who, e.Method, e.Path, status, e.DurationMs, size(e.ResBytes))}
	if bodies && e.ReqBody != "" {
		lines = append(lines, indented("req", e.ReqBody))
	}
	if bodies && e.ResBody != "" {
		lines = append(lines, indented("res", e.ResBody))
	}
	return strings.Join(lines, "\n")
}

func renderDigest(g httplog.DigestGroup) string {
	status := strconv.Itoa(g.Status)
	if g.Status == 0 {
		status = "refused"
	}
	span := ""
	if g.Count > 1 {
		span = fmt.Sprintf(" · first %s ago", describeUptime(g.FirstTS))
	}
	return fmt.Sprintf("[%s] %d× %s %s %s — last %s ago%s", g.Proc, g.Count, status, g.Method, g.Path, describeUptime(g.LastTS), span)
}
