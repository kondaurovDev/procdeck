// Package cli is procdeck's command line: the deck lifecycle (up, down,
// restart, status, ls, open, init) and the agent-facing commands (logs,
// mark, wait-for, errors, agents).
package cli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/kondaurovDev/procdeck/internal/config"
	"github.com/kondaurovDev/procdeck/internal/registry"
	"github.com/kondaurovDev/procdeck/internal/version"
)

// exitError ends the command with a code; an empty message means everything
// was already printed.
type exitError struct {
	code int
	msg  string
}

func (e *exitError) Error() string { return e.msg }

// fail is a user-facing failure: one line, exit code 1, no stack.
func fail(format string, args ...any) error {
	return &exitError{code: 1, msg: fmt.Sprintf(format, args...)}
}

// Execute runs the command line and returns the process exit code.
func Execute(args []string) int {
	root := newRoot()
	root.SetArgs(args)
	err := root.Execute()
	var exit *exitError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &exit):
		if exit.msg != "" {
			fmt.Fprintf(os.Stderr, "procdeck: %s\n", exit.msg)
		}
		return exit.code
	default:
		// Usage errors from argument parsing.
		fmt.Fprintf(os.Stderr, "procdeck: %s (see --help)\n", err)
		return 1
	}
}

func newRoot() *cobra.Command {
	var up upFlags
	root := &cobra.Command{
		Use:   "procdeck [config]",
		Short: "Dev-process multiplexer with a web UI. Without a subcommand, `procdeck` is `procdeck up`.",
		// A path is accepted where a subcommand would go: `procdeck deck.json`.
		Args:          cobra.MaximumNArgs(1),
		Version:       version.Version,
		SilenceErrors: true,
		SilenceUsage:  true,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runUp(firstArg(args), up)
		},
	}
	root.SetVersionTemplate("procdeck v{{.Version}}\n")
	up.register(root)
	root.AddCommand(
		initCmd(), upCmd(), downCmd(), restartCmd(), statusCmd(), lsCmd(), openCmd(),
		logsCmd(), httpCmd(), markCmd(), waitForCmd(), errorsCmd(), agentsCmd(), mcpCmd(),
	)
	return root
}

func firstArg(args []string) string {
	if len(args) == 0 {
		return ""
	}
	return args[0]
}

// resolveConfig finds the config file: the given path, else the nearest one
// up from the working directory. The result is a real path — the project's
// identity must not depend on symlinks (/var vs /private/var on macOS).
func resolveConfig(arg string) (string, error) {
	var found string
	if arg != "" {
		found, _ = filepath.Abs(arg)
	} else {
		cwd, _ := os.Getwd()
		found = config.Locate(cwd)
		if found == "" {
			return "", fail("no config file here or above — expected procdeck.config.json or procdeck.config.jsonc (or pass a path)")
		}
	}
	real, err := filepath.EvalSymlinks(found)
	if err != nil {
		return "", fail("config file not found: %s", found)
	}
	return real, nil
}

func load(file string) (*config.Loaded, error) {
	loaded, err := config.Load(file)
	var configErr *config.Error
	if errors.As(err, &configErr) {
		return nil, fail("%s: %s", pretty(configErr.File), configErr.Msg)
	}
	return loaded, err
}

// resolveRoot is the project root for down/status/open/logs: where the
// config lives.
func resolveRoot(arg string) (string, error) {
	file, err := resolveConfig(arg)
	if err != nil {
		return "", err
	}
	return filepath.Dir(file), nil
}

// requireInstance is the running deck for this project, or a failure.
func requireInstance(arg string) (registry.Instance, error) {
	root, err := resolveRoot(arg)
	if err != nil {
		return registry.Instance{}, err
	}
	instance, ok := registry.Find(root)
	if !ok {
		return registry.Instance{}, fail("nothing is up for %s — `procdeck up` first", pretty(root))
	}
	return instance, nil
}

// pretty shortens /Users/me/… to ~/… for terminal output.
func pretty(file string) string {
	home, err := os.UserHomeDir()
	if err == nil && home != "" && strings.HasPrefix(file, home) {
		return "~" + file[len(home):]
	}
	return file
}

var durationPattern = regexp.MustCompile(`^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$`)

// parseDuration reads "30s" / "5m" / "2h" / bare seconds.
func parseDuration(raw string) (time.Duration, bool) {
	match := durationPattern.FindStringSubmatch(strings.TrimSpace(raw))
	if match == nil {
		return 0, false
	}
	value, _ := strconv.ParseFloat(match[1], 64)
	unit := map[string]time.Duration{
		"ms": time.Millisecond, "": time.Second, "s": time.Second, "m": time.Minute, "h": time.Hour, "d": 24 * time.Hour,
	}[match[2]]
	return time.Duration(value * float64(unit)), true
}

// describeUptime renders the time since an epoch ms as "42s", "5m", "2h 3m"
// or "1d 4h".
func describeUptime(since int64) string {
	seconds := max(0, int(time.Since(time.UnixMilli(since)).Round(time.Second).Seconds()))
	switch {
	case seconds < 60:
		return fmt.Sprintf("%ds", seconds)
	case seconds < 3600:
		return fmt.Sprintf("%dm", seconds/60)
	case seconds < 86400:
		return fmt.Sprintf("%dh %dm", seconds/3600, seconds%3600/60)
	default:
		return fmt.Sprintf("%dd %dh", seconds/86400, seconds%86400/3600)
	}
}

// table aligns columns with two spaces between them.
func table(rows [][]string) string {
	var widths []int
	for _, row := range rows {
		for i, cell := range row {
			if i >= len(widths) {
				widths = append(widths, 0)
			}
			widths[i] = max(widths[i], len([]rune(cell)))
		}
	}
	out := make([]string, len(rows))
	for r, row := range rows {
		cells := make([]string, len(row))
		for i, cell := range row {
			if i < len(row)-1 {
				cell += strings.Repeat(" ", widths[i]-len([]rune(cell)))
			}
			cells[i] = cell
		}
		out[r] = strings.TrimRight(strings.Join(cells, "  "), " ")
	}
	return strings.Join(out, "\n")
}
