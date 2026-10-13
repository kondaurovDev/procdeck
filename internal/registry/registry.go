// Package registry is the instance registry: one JSON file per running deck
// under ~/.procdeck/instances/. It is how `procdeck down|status|open|logs`
// find the deck for the project they run in, how `procdeck ls` and the UI's
// deck switcher list every live deck, and it doubles as the pidfile.
//
// Plain files, no daemon: a deck writes its entry once it is listening and
// removes it on shutdown; readers drop entries whose pid is gone, so a
// crashed deck never lingers. PROCDECK_HOME relocates the whole tree (tests,
// sandboxes). The format is shared with procdeck 1.x — both can list and stop
// each other's decks.
package registry

import (
	"cmp"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
)

// Mode says how a deck was started.
type Mode string

const (
	Detached   Mode = "detached"
	Foreground Mode = "foreground"
)

// Instance is one running deck.
type Instance struct {
	// ID is derived from the root path — also the file and log name.
	ID string `json:"id"`
	// Name is the config's name, else the root's basename.
	Name string `json:"name"`
	// Root is the config file's directory; it identifies the project.
	Root string `json:"root"`
	// Config is the config file the deck was started from.
	Config string `json:"config"`
	Port   int    `json:"port"`
	Pid    int    `json:"pid"`
	// Log is where the deck's own output goes (detached mode).
	Log       string `json:"log"`
	StartedAt int64  `json:"startedAt"`
	Version   string `json:"version"`
	Mode      Mode   `json:"mode"`
}

// Home is PROCDECK_HOME, else ~/.procdeck.
func Home() string {
	if home := os.Getenv("PROCDECK_HOME"); home != "" {
		return home
	}
	user, err := os.UserHomeDir()
	if err != nil {
		user = os.TempDir()
	}
	return filepath.Join(user, ".procdeck")
}

func instancesDir() string { return filepath.Join(Home(), "instances") }
func logsDir() string      { return filepath.Join(Home(), "logs") }
func entryPath(id string) string {
	return filepath.Join(instancesDir(), id+".json")
}

// CanonicalRoot is one spelling of a project root, so the id never depends on
// how the path was reached: the cwd is a real path while a config argument may
// go through a symlink (macOS /var → /private/var).
func CanonicalRoot(root string) string {
	absolute, err := filepath.Abs(root)
	if err != nil {
		return root
	}
	if real, err := filepath.EvalSymlinks(absolute); err == nil {
		return real
	}
	return absolute
}

// ID is the same for the same root, whatever the deck is called today.
func ID(root string) string {
	sum := sha1.Sum([]byte(CanonicalRoot(root)))
	return hex.EncodeToString(sum[:])[:12]
}

// LogPath is where a detached deck for root writes its own output.
func LogPath(root string) string { return filepath.Join(logsDir(), ID(root)+".log") }

// IsAlive probes a pid with signal 0, which delivers nothing. EPERM means the
// process exists but belongs to someone else — still alive.
func IsAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

// EnsureHome creates the registry and log directories.
func EnsureHome() error {
	if err := os.MkdirAll(instancesDir(), 0o755); err != nil {
		return err
	}
	return os.MkdirAll(logsDir(), 0o755)
}

// Register writes the entry atomically: write a temp file, then rename, so a
// concurrent reader never sees a torn file.
func Register(instance Instance) error {
	if err := EnsureHome(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(instance, "", "  ")
	if err != nil {
		return err
	}
	target := entryPath(instance.ID)
	temp := target + "." + strconv.Itoa(os.Getpid()) + ".tmp"
	if err := os.WriteFile(temp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(temp, target)
}

// Deregister removes the entry — only if it is still pid's: a newer deck may
// have re-registered the same root.
func Deregister(id string, pid int) error {
	if current, ok := readEntry(id); ok && current.Pid != pid {
		return nil
	}
	err := os.Remove(entryPath(id))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func readEntry(id string) (Instance, bool) {
	data, err := os.ReadFile(entryPath(id))
	if err != nil {
		return Instance{}, false
	}
	var instance Instance
	if json.Unmarshal(data, &instance) != nil {
		return Instance{}, false
	}
	return instance, true
}

// List returns every live deck, sorted by name then port. Entries whose
// process is gone (or that don't parse) are pruned on the way.
func List() []Instance {
	files, err := os.ReadDir(instancesDir())
	if err != nil {
		return nil
	}
	var live []Instance
	for _, file := range files {
		id, ok := strings.CutSuffix(file.Name(), ".json")
		if !ok {
			continue
		}
		entry, ok := readEntry(id)
		if !ok || !IsAlive(entry.Pid) {
			os.Remove(filepath.Join(instancesDir(), file.Name()))
			continue
		}
		live = append(live, entry)
	}
	slices.SortFunc(live, func(a, b Instance) int {
		return cmp.Or(strings.Compare(a.Name, b.Name), cmp.Compare(a.Port, b.Port))
	})
	return live
}

// Find returns the live deck for a project root.
func Find(root string) (Instance, bool) {
	entry, ok := readEntry(ID(root))
	if !ok {
		return Instance{}, false
	}
	if !IsAlive(entry.Pid) {
		os.Remove(entryPath(entry.ID))
		return Instance{}, false
	}
	return entry, true
}

// FindByPort returns the live deck holding a port — to explain EADDRINUSE in
// procdeck's own terms.
func FindByPort(port int) (Instance, bool) {
	for _, instance := range List() {
		if instance.Port == port {
			return instance, true
		}
	}
	return Instance{}, false
}
