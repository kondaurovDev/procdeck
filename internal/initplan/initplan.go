// Package initplan plans `procdeck init`: a first config from what the
// project already says about itself, tried in this order:
//
//  1. a Procfile — already a list of processes;
//  2. workspaces (pnpm-workspace.yaml, `workspaces` in package.json) — one
//     proc per package with a dev script, via the lockfile's package manager;
//  3. plain subdirectories (backend/, frontend/ — no workspace declared) —
//     each with its own package.json dev script (its own lockfile decides the
//     manager) or a recognisable non-JS project (Django, Go, Rust, Rails,
//     docker compose), run with cwd set to that directory;
//  4. the root itself — its package.json dev script or a non-JS marker;
//  5. a template that runs, to be edited.
//
// No ports are guessed — `${port}` only helps when the command honours PORT,
// and that is the user's call.
package initplan

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// PackageManager runs a JS project's scripts.
type PackageManager string

const (
	PNPM PackageManager = "pnpm"
	Yarn PackageManager = "yarn"
	NPM  PackageManager = "npm"
	Bun  PackageManager = "bun"
)

// Source names the detector that produced a plan's procs.
type Source string

const (
	FromProcfile       Source = "Procfile"
	FromWorkspaces     Source = "workspaces"
	FromSubdirectories Source = "subdirectories"
	FromRoot           Source = "root"
	FromTemplate       Source = "template"
)

// SchemaURL is what a generated config points editors at.
const SchemaURL = "https://unpkg.com/procdeck/schema.json"

// Proc is one generated proc.
type Proc struct {
	ID    string `json:"id"`
	Shell string `json:"shell"`
	Cwd   string `json:"cwd,omitempty"`
}

// Config is the generated deck, in the order its keys are written.
type Config struct {
	Schema string `json:"$schema"`
	Name   string `json:"name"`
	Procs  []Proc `json:"procs"`
}

// Plan is what init would write.
type Plan struct {
	Config Config
	// Notes describe what was found, one line per proc, for the terminal.
	Notes  []string
	Source Source
}

type pkg struct {
	dir     string
	name    string
	scripts map[string]string
}

// devScripts are the scripts worth a pane, in order of preference.
var devScripts = []string{"dev", "start:dev", "serve", "watch", "start"}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func readPackage(root, dir string) (pkg, bool) {
	data, err := os.ReadFile(filepath.Join(root, dir, "package.json"))
	if err != nil {
		return pkg{}, false
	}
	var manifest struct {
		Name    string            `json:"name"`
		Scripts map[string]string `json:"scripts"`
	}
	if json.Unmarshal(data, &manifest) != nil {
		return pkg{}, false
	}
	name := manifest.Name
	if name == "" {
		name = filepath.Base(filepath.Join(root, dir))
	}
	return pkg{dir: dir, name: name, scripts: manifest.Scripts}, true
}

// DetectPackageManager picks the manager from the lockfile in dir.
func DetectPackageManager(dir string) PackageManager {
	switch {
	case exists(filepath.Join(dir, "pnpm-lock.yaml")):
		return PNPM
	case exists(filepath.Join(dir, "yarn.lock")):
		return Yarn
	case exists(filepath.Join(dir, "bun.lockb")), exists(filepath.Join(dir, "bun.lock")):
		return Bun
	}
	return NPM
}

func sortedDirs(dir string, keep func(name string) bool) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, entry := range entries {
		if entry.IsDir() && !strings.HasPrefix(entry.Name(), ".") && keep(entry.Name()) {
			names = append(names, entry.Name())
		}
	}
	slices.Sort(names)
	return names
}

// expandGlob expands workspace globs — `packages/*`, `apps/**`, `tools/cli` —
// one level deep: that is what the overwhelming majority of workspaces use,
// and a wrong guess is one line to fix in the generated file.
func expandGlob(root, pattern string) []string {
	clean := strings.TrimSuffix(strings.TrimSuffix(pattern, "/**"), "/*")
	if clean == pattern {
		if exists(filepath.Join(root, clean)) {
			return []string{clean}
		}
		return nil
	}
	var dirs []string
	for _, name := range sortedDirs(filepath.Join(root, clean), func(string) bool { return true }) {
		dirs = append(dirs, filepath.Join(clean, name))
	}
	return dirs
}

var (
	yamlComment     = regexp.MustCompile(`#.*$`)
	packagesKey     = regexp.MustCompile(`^packages:\s*$`)
	packagesItem    = regexp.MustCompile(`^\s+-\s*["']?([^"']+?)["']?\s*$`)
	procfileEntry   = regexp.MustCompile(`^\s*([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*$`)
	scopePrefix     = regexp.MustCompile(`^@[^/]+/`)
	paneUnsafeChars = regexp.MustCompile(`(?i)[^a-z0-9-]`)
)

// pnpmWorkspaceGlobs reads the `packages:` list of pnpm-workspace.yaml — a
// flat YAML list, read by hand.
func pnpmWorkspaceGlobs(root string) ([]string, bool) {
	data, err := os.ReadFile(filepath.Join(root, "pnpm-workspace.yaml"))
	if err != nil {
		return nil, false
	}
	var globs []string
	inPackages := false
	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimRight(yamlComment.ReplaceAllString(raw, ""), " \t\r")
		if packagesKey.MatchString(line) {
			inPackages = true
			continue
		}
		if !inPackages {
			continue
		}
		if item := packagesItem.FindStringSubmatch(line); item != nil {
			globs = append(globs, item[1])
		} else if strings.TrimSpace(line) != "" {
			inPackages = false
		}
	}
	return globs, true
}

func workspaceGlobs(root string) []string {
	if globs, ok := pnpmWorkspaceGlobs(root); ok {
		return globs
	}
	data, err := os.ReadFile(filepath.Join(root, "package.json"))
	if err != nil {
		return nil
	}
	var manifest struct {
		Workspaces json.RawMessage `json:"workspaces"`
	}
	if json.Unmarshal(data, &manifest) != nil || manifest.Workspaces == nil {
		return nil
	}
	var list []string
	if json.Unmarshal(manifest.Workspaces, &list) == nil {
		return list
	}
	var object struct {
		Packages []string `json:"packages"`
	}
	json.Unmarshal(manifest.Workspaces, &object)
	return object.Packages
}

func devScript(p pkg) (string, bool) {
	for _, script := range devScripts {
		if _, ok := p.scripts[script]; ok {
			return script, true
		}
	}
	return "", false
}

// workspaceCommand runs a package's script through the workspace tool.
func workspaceCommand(pm PackageManager, p pkg, script string) string {
	switch pm {
	case PNPM:
		return fmt.Sprintf("pnpm --filter %s %s", p.name, script)
	case Yarn:
		return fmt.Sprintf("yarn workspace %s %s", p.name, script)
	case Bun:
		return fmt.Sprintf("bun run --filter %s %s", p.name, script)
	default:
		return fmt.Sprintf("npm run %s -w %s", script, p.name)
	}
}

func rootCommand(pm PackageManager, script string) string {
	return fmt.Sprintf("%s run %s", pm, script)
}

// paneID is the package name without scope, unique within the deck.
func paneID(name string, taken map[string]bool) string {
	base := strings.ToLower(paneUnsafeChars.ReplaceAllString(scopePrefix.ReplaceAllString(name, ""), "-"))
	if base == "" {
		base = "app"
	}
	id := base
	for n := 2; taken[id]; n++ {
		id = fmt.Sprintf("%s-%d", base, n)
	}
	taken[id] = true
	return id
}

// nonJSMarkers are non-JS projects with one obvious dev command; everything
// else is left to the user.
var nonJSMarkers = []struct{ file, shell, what string }{
	{"manage.py", "python manage.py runserver", "Django"},
	{"bin/rails", "bin/rails server", "Rails"},
	{"go.mod", "go run .", "Go"},
	{"Cargo.toml", "cargo run", "Rust"},
	{"mix.exs", "mix phx.server", "Phoenix"},
	{"docker-compose.yml", "docker compose up", "docker compose"},
	{"docker-compose.yaml", "docker compose up", "docker compose"},
	{"compose.yaml", "docker compose up", "docker compose"},
	{"compose.yml", "docker compose up", "docker compose"},
}

func nonJSCommand(dir string) (shell, what string, ok bool) {
	for _, marker := range nonJSMarkers {
		if !exists(filepath.Join(dir, marker.file)) {
			continue
		}
		// Phoenix only if it is one — mix.exs alone could be any Elixir app.
		if marker.what == "Phoenix" {
			mix, _ := os.ReadFile(filepath.Join(dir, "mix.exs"))
			if !strings.Contains(string(mix), ":phoenix") {
				return "", "", false
			}
		}
		return marker.shell, marker.what, true
	}
	return "", "", false
}

// procfile reads `name: command` lines — the Heroku/foreman format.
func procfile(root string) []Proc {
	data, err := os.ReadFile(filepath.Join(root, "Procfile"))
	if err != nil {
		return nil
	}
	var procs []Proc
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(strings.TrimLeft(line, " \t"), "#") {
			continue
		}
		if match := procfileEntry.FindStringSubmatch(line); match != nil {
			procs = append(procs, Proc{ID: match[1], Shell: match[2]})
		}
	}
	return procs
}

// skipDirs are never sub-projects.
var skipDirs = map[string]bool{
	"node_modules": true, "dist": true, "build": true, "vendor": true, "target": true, "coverage": true, "tmp": true,
}

type project struct{ name, shell, what string }

// projectIn is what one directory would run: its package.json dev script,
// else a non-JS marker.
func projectIn(root, dir string, fallback PackageManager) (project, bool) {
	if p, ok := readPackage(root, dir); ok {
		if script, ok := devScript(p); ok {
			// The directory's own lockfile wins; otherwise the root's (or npm).
			here := filepath.Join(root, dir)
			pm := DetectPackageManager(here)
			if pm == NPM && !exists(filepath.Join(here, "package-lock.json")) {
				pm = fallback
			}
			return project{name: p.name, shell: rootCommand(pm, script), what: script}, true
		}
	}
	if shell, what, ok := nonJSCommand(filepath.Join(root, dir)); ok {
		return project{name: filepath.Base(filepath.Join(root, dir)), shell: shell, what: what}, true
	}
	return project{}, false
}

// Detect plans the config for the project at root.
func Detect(root string) Plan {
	pm := DetectPackageManager(root)
	name := filepath.Base(root)
	if p, ok := readPackage(root, "."); ok {
		name = scopePrefix.ReplaceAllString(p.name, "")
	}
	taken := map[string]bool{}
	done := func(procs []Proc, notes []string, source Source) Plan {
		return Plan{Config: Config{Schema: SchemaURL, Name: name, Procs: procs}, Notes: notes, Source: source}
	}

	// 1. Procfile: somebody already wrote the list.
	if declared := procfile(root); len(declared) > 0 {
		var procs []Proc
		var notes []string
		for _, proc := range declared {
			procs = append(procs, Proc{ID: paneID(proc.ID, taken), Shell: proc.Shell})
			notes = append(notes, fmt.Sprintf("%-16s Procfile  (%s)", proc.ID, proc.Shell))
		}
		return done(procs, notes, FromProcfile)
	}

	// 2. Workspaces.
	var dirs []string
	for _, glob := range workspaceGlobs(root) {
		if strings.HasPrefix(glob, "!") {
			continue
		}
		for _, dir := range expandGlob(root, glob) {
			if !slices.Contains(dirs, dir) {
				dirs = append(dirs, dir)
			}
		}
	}
	var procs []Proc
	var notes []string
	for _, dir := range dirs {
		p, ok := readPackage(root, dir)
		if !ok {
			continue
		}
		script, ok := devScript(p)
		if !ok {
			continue
		}
		id := paneID(p.name, taken)
		procs = append(procs, Proc{ID: id, Shell: workspaceCommand(pm, p, script)})
		notes = append(notes, fmt.Sprintf("%-16s %s  (%s)", id, dir, script))
	}
	if len(procs) > 0 {
		return done(procs, notes, FromWorkspaces)
	}

	// 3. Plain subdirectories, each its own project.
	for _, dir := range sortedDirs(root, func(name string) bool { return !skipDirs[name] }) {
		p, ok := projectIn(root, dir, pm)
		if !ok {
			continue
		}
		id := paneID(p.name, taken)
		procs = append(procs, Proc{ID: id, Shell: p.shell, Cwd: dir})
		notes = append(notes, fmt.Sprintf("%-16s %s/  (%s)", id, dir, p.what))
	}
	if len(procs) > 0 {
		return done(procs, notes, FromSubdirectories)
	}

	// 4. The root itself.
	if p, ok := projectIn(root, ".", pm); ok {
		id := paneID(p.name, taken)
		return done([]Proc{{ID: id, Shell: p.shell}}, []string{fmt.Sprintf("%-16s .  (%s)", id, p.what)}, FromRoot)
	}

	// 5. Nothing to go on — a template that runs, to be edited.
	return done(
		[]Proc{{ID: "app", Shell: "echo 'edit procdeck.config.json'; sleep 1000"}},
		[]string{"nothing recognisable here (package.json scripts, Procfile, Django/Go/Rust/Rails/compose) — wrote a template to edit"},
		FromTemplate,
	)
}
