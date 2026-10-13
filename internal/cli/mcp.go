package cli

import (
	"github.com/spf13/cobra"

	"github.com/kondaurovDev/procdeck/internal/mcpserver"
	"github.com/kondaurovDev/procdeck/internal/version"
)

func mcpCmd() *cobra.Command {
	var mutations bool
	cmd := &cobra.Command{
		Use:   "mcp",
		Short: "MCP server over stdio for coding agents",
		Long:  "MCP server over stdio for coding agents: deck_status, get_logs, get_http, timeline, get_errors, set_mark, wait_for — the same verbs as the CLI. Add once, globally: `claude mcp add procdeck -- procdeck mcp`; the instance registry finds the right deck for whatever project the agent is in.",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx, stop := interruptible(cmd.Context())
			defer stop()
			if err := mcpserver.Run(ctx, version.Version, mutations); err != nil {
				return fail("%s", err)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&mutations, "mutations", false, "also expose restart_proc / stop_proc / start_proc (default: read-only)")
	return cmd
}
