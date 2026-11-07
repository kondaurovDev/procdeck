package cli

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	"github.com/spf13/cobra"

	"github.com/kondaurovDev/procdeck/internal/deckclient"
)

// selectorHelp is the one description of what `start`, `stop` and `restart`
// take: a proc id, a group from the config (every proc in it), or a glob
// over ids — quoted, so the shell leaves it alone.
const selectorHelp = "Each argument is a proc id, a `group` from the config (every proc in it), or a glob over ids (`'*-native'`, quoted)."

func startCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "start <proc|group|glob>...",
		Short: "Start procs that are not running",
		Long:  "Start procs that are not running — the ones with `autostart: false`, or stopped earlier. " + selectorHelp + " Procs with `needs` wait for their dependencies as usual.",
		Args:  cobra.MinimumNArgs(1),
		RunE:  func(cmd *cobra.Command, args []string) error { return actOnProcs(cmd.Context(), "start", args) },
	}
}

func stopCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "stop <proc|group|glob>...",
		Short: "Stop procs, keeping the deck up",
		Long:  "Stop procs without taking the deck down: their process trees are terminated and the panes stay, idle, until `procdeck start`. " + selectorHelp,
		Args:  cobra.MinimumNArgs(1),
		RunE:  func(cmd *cobra.Command, args []string) error { return actOnProcs(cmd.Context(), "stop", args) },
	}
}

// actOnProcs runs one lifecycle verb over every selector, in order, and
// reports which procs it reached. The deck resolves the names, so the CLI
// and the UI agree on what "career" means.
func actOnProcs(ctx context.Context, verb string, selectors []string) error {
	instance, err := requireInstance("")
	if err != nil {
		return err
	}
	var reached []string
	for _, selector := range selectors {
		var answer struct {
			Procs []string `json:"procs"`
		}
		if err := deckclient.Post(ctx, instance, "/procs/"+url.PathEscape(selector)+"/"+verb, struct{}{}, &answer); err != nil {
			return fail("%s", err)
		}
		reached = append(reached, answer.Procs...)
	}
	past := map[string]string{"start": "started", "stop": "stopped", "restart": "restarted"}[verb]
	fmt.Printf("procdeck: %s %s", past, strings.Join(reached, ", "))
	if verb != "stop" {
		fmt.Printf(" — `procdeck wait-for %s` to await readiness", reached[0])
	}
	fmt.Println()
	return nil
}
