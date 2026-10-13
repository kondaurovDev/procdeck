package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/kondaurovDev/procdeck/internal/config"
	"github.com/kondaurovDev/procdeck/internal/deckclient"
	"github.com/kondaurovDev/procdeck/internal/discover"
	"github.com/kondaurovDev/procdeck/internal/initplan"
	"github.com/kondaurovDev/procdeck/internal/registry"
	"github.com/kondaurovDev/procdeck/internal/supervisor"
	"github.com/kondaurovDev/procdeck/internal/version"
)

// upFlags are shared by the root command, `up` and `restart`.
type upFlags struct {
	fg     bool
	open   bool
	noOpen bool
}

func (f *upFlags) register(cmd *cobra.Command) {
	cmd.Flags().BoolVar(&f.fg, "fg", false, "run in the foreground — Ctrl-C stops the deck")
	cmd.Flags().BoolVar(&f.open, "open", true, "open the UI in the browser")
	cmd.Flags().BoolVar(&f.noOpen, "no-open", false, "do not open the UI in the browser")
}

func (f upFlags) opens() bool { return f.open && !f.noOpen }

func upCmd() *cobra.Command {
	var flags upFlags
	cmd := &cobra.Command{
		Use:   "up [config]",
		Short: "Start the deck (detached) and open its UI",
		Long:  "Start the deck and open its UI. Detaches by default: the deck keeps running after the terminal closes (`procdeck down` stops it). Idempotent — an already-running deck is just opened.",
		Args:  cobra.MaximumNArgs(1),
		RunE:  func(cmd *cobra.Command, args []string) error { return runUp(firstArg(args), flags) },
	}
	flags.register(cmd)
	return cmd
}

func runUp(configArg string, flags upFlags) error {
	configPath, err := resolveConfig(configArg)
	if err != nil {
		return err
	}
	loaded, err := load(configPath)
	if err != nil {
		return err
	}
	if flags.fg {
		return runForeground(loaded)
	}

	if running, ok := registry.Find(loaded.Root); ok {
		fmt.Printf("procdeck: %q is already up → %s (pid %d)\n", running.Name, deckclient.URL(running), running.Pid)
		versionNotice(running)
		if flags.opens() {
			openBrowser(deckclient.URL(running))
		}
		return nil
	}
	port := loaded.Config.UIPort()
	if holder, ok := registry.FindByPort(port); ok {
		return fail("port %d is taken by deck %q (%s) — set \"port\" in the config, or `procdeck down` there", port, holder.Name, pretty(holder.Root))
	}
	// Probe here, in the terminal, rather than let the child find out and die
	// in its log file.
	if !isPortFree(port, loaded.Config.UIHost()) {
		return fail("port %d is busy (not a procdeck deck) — set \"port\" in the config", port)
	}

	instance, err := detach(configPath, loaded.Root)
	if err != nil {
		return fail("%s", err)
	}
	fmt.Printf("procdeck: %q is up → %s\n", instance.Name, deckclient.URL(instance))
	fmt.Printf("  pid %d · log %s\n", instance.Pid, pretty(instance.Log))
	fmt.Println("  procdeck down · status · logs --self -f · open")
	if flags.opens() {
		openBrowser(deckclient.URL(instance))
	}
	return nil
}

// versionNotice is one line when a deck was started by a different procdeck
// than this CLI.
func versionNotice(instance registry.Instance) {
	if instance.Version != version.Version {
		fmt.Printf("procdeck: deck runs v%s, CLI is v%s — `procdeck restart` picks up the new version\n", instance.Version, version.Version)
	}
}

func downCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "down [config]",
		Short: "Stop the deck and every process tree",
		Long:  "Stop the deck: every process tree is terminated, then procdeck exits.",
		Args:  cobra.MaximumNArgs(1),
		RunE:  func(cmd *cobra.Command, args []string) error { return runDown(firstArg(args)) },
	}
}

func runDown(configArg string) error {
	root, err := resolveRoot(configArg)
	if err != nil {
		return err
	}
	instance, ok := registry.Find(root)
	if !ok {
		fmt.Printf("procdeck: nothing is up for %s\n", pretty(root))
		return nil
	}
	fmt.Printf("procdeck: stopping %q (pid %d)… ", instance.Name, instance.Pid)
	if shutdown(instance) {
		fmt.Println("did not stop in time, killed")
	} else {
		fmt.Println("down")
	}
	return nil
}

func restartCmd() *cobra.Command {
	var flags upFlags
	var all bool
	cmd := &cobra.Command{
		Use:   "restart [proc]",
		Short: "Restart one proc, the whole deck, or every deck",
		Long:  "Restart one proc (`restart api`), the whole deck (`restart`), or every deck on this machine (`restart --all`) — the deck-wide forms after updating procdeck or editing the config.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			proc := firstArg(args)
			switch {
			case all && proc != "":
				return fail("--all restarts every deck — drop %q", proc)
			case all:
				return restartAll()
			case proc != "":
				return restartProc(cmd.Context(), proc)
			}
			if err := runDown(""); err != nil {
				return err
			}
			return runUp("", flags)
		},
	}
	flags.register(cmd)
	cmd.Flags().BoolVar(&all, "all", false, "restart every deck on this machine (e.g. after updating procdeck)")
	return cmd
}

func restartProc(ctx context.Context, proc string) error {
	instance, err := requireInstance("")
	if err != nil {
		return err
	}
	var procs []supervisor.Info
	if err := deckclient.Get(ctx, instance, "/procs", &procs); err != nil {
		return fail("%s", err)
	}
	var ids []string
	for _, info := range procs {
		ids = append(ids, info.ID)
	}
	if !slices.Contains(ids, proc) {
		return fail("unknown proc %q — one of: %s", proc, strings.Join(ids, ", "))
	}
	if err := deckclient.Post(ctx, instance, "/procs/"+url.PathEscape(proc)+"/restart", struct{}{}, nil); err != nil {
		return fail("%s", err)
	}
	fmt.Printf("procdeck: %q restarted — `procdeck wait-for %s` to await readiness\n", proc, proc)
	return nil
}

// restartAll stops and detaches again every deck in the registry, straight
// from its entry (config path + root). Foreground decks are skipped: killing
// someone's terminal session from another shell and re-parenting it into the
// background would be a surprise, not a restart. One deck failing to come
// back does not stop the rest.
func restartAll() error {
	instances := registry.List()
	if len(instances) == 0 {
		fmt.Println("procdeck: no decks are up")
		return nil
	}
	failures := 0
	for _, instance := range instances {
		if instance.Mode == registry.Foreground {
			fmt.Printf("procdeck: skipping %q (%s) — foreground deck, restart it in its own terminal\n", instance.Name, pretty(instance.Root))
			continue
		}
		fmt.Printf("procdeck: restarting %q (%s)… ", instance.Name, pretty(instance.Root))
		shutdown(instance)
		fresh, err := detach(instance.Config, instance.Root)
		if err != nil {
			failures++
			fmt.Printf("failed: %s\n", err)
			continue
		}
		fmt.Printf("up → %s (v%s)\n", deckclient.URL(fresh), fresh.Version)
	}
	if failures > 0 {
		plural := "s"
		if failures == 1 {
			plural = ""
		}
		return fail("%d deck%s did not come back — see above", failures, plural)
	}
	return nil
}

func countRunning(procs []supervisor.Info, ok bool) string {
	if !ok {
		return "not answering"
	}
	running := 0
	for _, info := range procs {
		if info.Status.State == supervisor.Running {
			running++
		}
	}
	return fmt.Sprintf("%d/%d running", running, len(procs))
}

func statusCmd() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "status [config]",
		Short: "This project's deck and every proc's state",
		Long:  "This project's deck: address, uptime, and every proc's state. `--json` adds an `attention` list (crashed / blocked / alerting procs) — the cheapest first question for an agent.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			root, err := resolveRoot(firstArg(args))
			if err != nil {
				return err
			}
			instance, ok := registry.Find(root)
			if !ok {
				if !asJSON {
					return fail("nothing is up for %s", pretty(root))
				}
				data, _ := json.Marshal(map[string]any{"up": false, "root": root})
				fmt.Println(string(data))
				return &exitError{code: 1}
			}
			if asJSON {
				data, _ := json.Marshal(deckclient.Status(cmd.Context(), instance))
				fmt.Println(string(data))
				return nil
			}
			procs, answered := deckclient.Procs(cmd.Context(), instance)
			mode := ""
			if instance.Mode == registry.Foreground {
				mode = " · foreground"
			}
			fmt.Printf("%s · %s · up %s · pid %d · %s · v%s%s\n", instance.Name, deckclient.URL(instance),
				describeUptime(instance.StartedAt), instance.Pid, countRunning(procs, answered), instance.Version, mode)
			versionNotice(instance)
			if len(procs) == 0 {
				return nil
			}
			var rows [][]string
			for _, info := range procs {
				alert := ""
				if info.Status.Alert != "" {
					alert = "⚠ " + info.Status.Alert
				}
				rows = append(rows, []string{"  " + info.ID, deckclient.DescribeProc(info), info.ProxyURL, alert})
			}
			fmt.Println(table(rows))
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "machine-readable output (for agents and scripts)")
	return cmd
}

func lsCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "ls",
		Short: "Every running deck on this machine",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			instances := registry.List()
			if len(instances) == 0 {
				fmt.Println("procdeck: no decks are up")
				return nil
			}
			rows := make([][]string, len(instances))
			outdated := false
			for i, instance := range instances {
				procs, ok := deckclient.Procs(cmd.Context(), instance)
				rows[i] = []string{
					instance.Name, fmt.Sprintf(":%d", instance.Port), "up " + describeUptime(instance.StartedAt),
					countRunning(procs, ok), "v" + instance.Version, pretty(instance.Root),
				}
				outdated = outdated || instance.Version != version.Version
			}
			fmt.Println(table(rows))
			if outdated {
				fmt.Printf("procdeck: some decks run a different procdeck than the CLI (v%s) — `procdeck restart --all` brings them over\n", version.Version)
			}
			return nil
		},
	}
}

func openCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "open [config]",
		Short: "Open the deck's UI in the browser",
		Long:  "Open the deck's UI in the browser — no port to remember.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			instance, err := requireInstance(firstArg(args))
			if err != nil {
				return err
			}
			fmt.Printf("procdeck: opening %s\n", deckclient.URL(instance))
			openBrowser(deckclient.URL(instance))
			return nil
		},
	}
}

func initCmd() *cobra.Command {
	var force bool
	cmd := &cobra.Command{
		Use:   "init",
		Short: "Write a procdeck.config.json from what the project already has",
		Long:  "Write a procdeck.config.json for this project from what is already there: a Procfile, workspace packages with dev scripts, plain subdirectories (each its own package.json / Django / Go / Rust / Rails / compose project), or the root itself.",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			root, _ := os.Getwd()
			if existing := config.Discover(root); existing != "" && !force {
				return fail("%s already exists here (--force to overwrite)", filepath.Base(existing))
			}
			plan := initplan.Detect(root)
			data, _ := json.MarshalIndent(plan.Config, "", "  ")
			file := filepath.Join(root, config.FileNames[0])
			if err := os.WriteFile(file, append(data, '\n'), 0o644); err != nil {
				return fail("%s", err)
			}
			// Round-trip through the real loader: what we wrote must be a deck.
			if _, err := load(file); err != nil {
				return err
			}
			plural := "s"
			if len(plan.Config.Procs) == 1 {
				plural = ""
			}
			fmt.Printf("procdeck: wrote %s — %d proc%s from %s\n", config.FileNames[0], len(plan.Config.Procs), plural, plan.Source)
			for _, note := range plan.Notes {
				fmt.Println("  " + note)
			}
			// A project that already instructs agents gets the procdeck section
			// for free — that is how the agent learns the deck exists.
			instructions := discover.FindInstructionsFile(root)
			if instructions != "" {
				if appended, _ := discover.AppendSnippet(instructions); appended {
					fmt.Printf("  %s — added a \"## procdeck\" section for coding agents\n", filepath.Base(instructions))
				}
			}
			fmt.Println()
			fmt.Println("next: `procdeck up`")
			fmt.Println(`tip:  "env": { "PORT": "${port}" } hands a proc a free port (also as ${port:id} for others),`)
			fmt.Println(`      "needs": ["api"] makes a proc wait for another — see https://github.com/kondaurovDev/procdeck#config`)
			if instructions == "" {
				fmt.Println("tip:  `procdeck agents` introduces the deck to coding agents (CLAUDE.md + a skill)")
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&force, "force", false, "overwrite an existing config")
	return cmd
}
