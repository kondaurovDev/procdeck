// Package config is the deck config: its types, the JSONC loader and the
// validation rules. The published schema.json describes the same shape for
// editor completion; this package is what the runtime enforces.
package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/tailscale/hujson"
)

const (
	// DefaultUIPort is the port of the UI + proxy server.
	DefaultUIPort = 4820
	// DefaultUIHost is loopback only — the UI takes keystrokes into PTYs.
	DefaultUIHost = "127.0.0.1"
)

// Config is a deck: the web UI's settings and the processes it supervises.
type Config struct {
	// Schema points editors at the published JSON schema; meaningless at
	// runtime.
	Schema string `json:"$schema,omitempty"`
	// Name is the tab title and the installed web app's name; defaults to the
	// config directory's basename.
	Name string `json:"name,omitempty"`
	// Port serves the web UI and the `*.localhost` proxy; defaults to 4820.
	Port *int `json:"port,omitempty"`
	// Host is the interface the UI and proxy bind to; defaults to loopback.
	Host string `json:"host,omitempty"`
	// EnvFile names dotenv files, relative to the config's directory, whose
	// variables every proc and preflight sees.
	EnvFile EnvFiles `json:"envFile,omitempty"`
	Procs   []Proc   `json:"procs"`
}

// EnvFiles is one path or a list of them; later files override earlier ones.
type EnvFiles []string

func (f *EnvFiles) UnmarshalJSON(data []byte) error {
	var one string
	if json.Unmarshal(data, &one) == nil {
		*f = EnvFiles{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(data, &many); err != nil {
		return errors.New("envFile: expected a path or a list of paths")
	}
	*f = many
	return nil
}

// UIPort is the configured UI port or the default.
func (c *Config) UIPort() int {
	if c.Port == nil {
		return DefaultUIPort
	}
	return *c.Port
}

// UIHost is the configured bind address or the default.
func (c *Config) UIHost() string {
	if c.Host == "" {
		return DefaultUIHost
	}
	return c.Host
}

// ReadyWhen says what "ready" means for dependents.
type ReadyWhen string

const (
	// ReadyListening (the default): the process tree opened a TCP port.
	ReadyListening ReadyWhen = "listening"
	// ReadyStarted: it merely spawned, for procs that never listen.
	ReadyStarted ReadyWhen = "started"
)

// Proc is a single supervised process. Exactly one of Shell / Cmd is used:
// Shell goes through `$SHELL -c` (pipes, `&&`, globs work), Cmd is an argv
// executed directly.
type Proc struct {
	// ID is the pane label and the proxy subdomain (`api` → api.localhost).
	ID    string   `json:"id"`
	Shell string   `json:"shell,omitempty"`
	Cmd   []string `json:"cmd,omitempty"`
	// Cwd is relative to the config file's directory; defaults to it.
	Cwd string `json:"cwd,omitempty"`
	// Env is added on top of the inherited environment; values may use
	// `${port}` templates.
	Env map[string]string `json:"env,omitempty"`
	// Autostart defaults to true; false leaves the pane idle until Start.
	Autostart *bool `json:"autostart,omitempty"`
	// URL is shown in the UI as a link and pins readiness to its port.
	URL string `json:"url,omitempty"`
	// Port pins the assigned `${port}` to a fixed public number.
	Port      *int      `json:"port,omitempty"`
	Needs     []string  `json:"needs,omitempty"`
	ReadyWhen ReadyWhen `json:"readyWhen,omitempty"`
	// Observe routes the assigned port through the HTTP observer; defaults to
	// true for procs that use `${port}`.
	Observe   *bool      `json:"observe,omitempty"`
	Preflight *Preflight `json:"preflight,omitempty"`
	Alerts    []Alert    `json:"alerts,omitempty"`
}

// Autostarts reports whether the proc spawns on startup.
func (p *Proc) Autostarts() bool { return p.Autostart == nil || *p.Autostart }

// Observed reports whether an assigned port goes through the HTTP observer.
func (p *Proc) Observed() bool { return p.Observe == nil || *p.Observe }

// Preflight is a gate that must pass before the process spawns — e.g.
// `wrangler whoami` before a proc whose tree needs a Cloudflare token.
type Preflight struct {
	Shell string `json:"shell"`
	// Expect is a regexp the check's output must also match, for checks that
	// exit 0 either way.
	Expect string `json:"expect,omitempty"`
	// Hint tells the human what to do when the check fails.
	Hint string `json:"hint,omitempty"`
}

// Alert is a regexp watched in the pane output; a match raises a badge.
type Alert struct {
	Pattern string `json:"pattern"`
	Label   string `json:"label"`
}

// Parse decodes and validates a config. Comments and trailing commas are
// allowed; unknown keys are not — a typo must not be silently ignored.
func Parse(data []byte) (*Config, error) {
	standard, err := hujson.Standardize(bytes.Clone(data))
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(standard))
	decoder.DisallowUnknownFields()
	var config Config
	if err := decoder.Decode(&config); err != nil {
		return nil, describeDecodeError(err)
	}
	if err := config.validate(); err != nil {
		return nil, err
	}
	return &config, nil
}

func describeDecodeError(err error) error {
	var typeErr *json.UnmarshalTypeError
	if errors.As(err, &typeErr) && typeErr.Field != "" {
		return fmt.Errorf("%s: expected %s, got %s", typeErr.Field, typeErr.Type, typeErr.Value)
	}
	return errors.New(strings.TrimPrefix(err.Error(), "json: "))
}

func (c *Config) validate() error {
	if c.Procs == nil {
		return errors.New(`missing "procs"`)
	}
	if c.Port != nil && !validPort(*c.Port) {
		return fmt.Errorf("port %d is out of range 1–65535", *c.Port)
	}
	if slices.Contains(c.EnvFile, "") {
		return errors.New("envFile: a path must not be empty")
	}
	for i := range c.Procs {
		if err := c.Procs[i].validate(i); err != nil {
			return err
		}
	}
	return firstErr(validateGraph(c.Procs), validatePortTemplates(c.Procs), validatePinnedPorts(c))
}

func firstErr(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

func validPort(port int) bool { return port >= 1 && port <= 65535 }

func (p *Proc) validate(index int) error {
	if p.ID == "" {
		return fmt.Errorf(`procs[%d]: missing "id"`, index)
	}
	fail := func(format string, args ...any) error {
		return fmt.Errorf("proc %q: %s", p.ID, fmt.Sprintf(format, args...))
	}
	if (p.Shell == "") == (p.Cmd == nil) {
		return fail("expected exactly one of `shell` or `cmd`")
	}
	if p.Cmd != nil && len(p.Cmd) == 0 {
		return fail("`cmd` must not be empty")
	}
	if p.Port != nil && !validPort(*p.Port) {
		return fail("port %d is out of range 1–65535", *p.Port)
	}
	if p.ReadyWhen != "" && p.ReadyWhen != ReadyListening && p.ReadyWhen != ReadyStarted {
		return fail(`readyWhen must be "listening" or "started", got %q`, p.ReadyWhen)
	}
	if p.Preflight != nil {
		if p.Preflight.Shell == "" {
			return fail("`preflight.shell` must not be empty")
		}
		if err := checkRegex(p.Preflight.Expect); err != nil {
			return fail("preflight.expect: %v", err)
		}
	}
	for i, alert := range p.Alerts {
		if err := checkRegex(alert.Pattern); err != nil {
			return fail("alerts[%d].pattern: %v", i, err)
		}
		if alert.Label == "" {
			return fail("alerts[%d]: missing label", i)
		}
	}
	return nil
}

func checkRegex(pattern string) error {
	if _, err := regexp.Compile(pattern); err != nil {
		return fmt.Errorf("expected a valid regular expression (%w)", err)
	}
	return nil
}

// validateGraph reports duplicate ids, unknown `needs` targets and dependency
// cycles.
func validateGraph(procs []Proc) error {
	needs := make(map[string][]string, len(procs))
	for _, proc := range procs {
		if _, dup := needs[proc.ID]; dup {
			return errors.New("duplicate proc ids")
		}
		needs[proc.ID] = proc.Needs
	}
	for _, proc := range procs {
		for _, need := range proc.Needs {
			if _, ok := needs[need]; !ok {
				return fmt.Errorf("proc %q needs unknown proc %q", proc.ID, need)
			}
		}
	}

	// Depth-first search over `needs`; a node on the current path twice is a
	// cycle.
	done := map[string]bool{}
	onPath := map[string]bool{}
	var visit func(id string) error
	visit = func(id string) error {
		if done[id] {
			return nil
		}
		if onPath[id] {
			return fmt.Errorf("dependency cycle through %q", id)
		}
		onPath[id] = true
		for _, need := range needs[id] {
			if err := visit(need); err != nil {
				return err
			}
		}
		delete(onPath, id)
		done[id] = true
		return nil
	}
	for _, proc := range procs {
		if err := visit(proc.ID); err != nil {
			return err
		}
	}
	return nil
}

// validatePortTemplates: `${port:x}` must point at an existing proc that
// itself uses `${port}`.
func validatePortTemplates(procs []Proc) error {
	byID := make(map[string]*Proc, len(procs))
	for i := range procs {
		byID[procs[i].ID] = &procs[i]
	}
	for _, proc := range procs {
		for _, ref := range portRefs(&proc) {
			target, ok := byID[ref]
			if !ok {
				return fmt.Errorf(`proc %q references ${port:%s} but there is no proc %q`, proc.ID, ref, ref)
			}
			if !UsesOwnPort(target) {
				return fmt.Errorf(`proc %q references ${port:%s} but %q does not use ${port} itself`, proc.ID, ref, ref)
			}
		}
	}
	return nil
}

// validatePinnedPorts: a pin only makes sense on a proc procdeck assigns a
// port to — with no `${port}` the process binds whatever its own script says.
// Pins must also not collide, with each other or with the UI's port.
func validatePinnedPorts(c *Config) error {
	holders := map[int]string{}
	for _, proc := range c.Procs {
		if proc.Port == nil {
			continue
		}
		port := *proc.Port
		if !UsesOwnPort(&proc) {
			return fmt.Errorf(`proc %q pins port %d but does not use ${port} — the pin is the public side of an assigned port`, proc.ID, port)
		}
		if port == c.UIPort() {
			return fmt.Errorf("proc %q pins port %d, which is the deck UI's own port", proc.ID, port)
		}
		if holder, taken := holders[port]; taken {
			return fmt.Errorf("procs %q and %q pin the same port %d", holder, proc.ID, port)
		}
		holders[port] = proc.ID
	}
	return nil
}

// portTemplate matches `${port}` — a free port procdeck assigns to this proc
// before spawning — and `${port:api}`, the port assigned to another proc.
// Allowed in `shell`, `cmd`, `env` values and `url`.
var portTemplate = regexp.MustCompile(`\$\{port(?::([^}]+))?\}`)

// templated lists the strings that may carry port templates, env values in
// key order so validation messages are deterministic.
func templated(p *Proc) []string {
	var out []string
	if p.Shell != "" {
		out = append(out, p.Shell)
	}
	out = append(out, p.Cmd...)
	for _, key := range slices.Sorted(maps.Keys(p.Env)) {
		out = append(out, p.Env[key])
	}
	if p.URL != "" {
		out = append(out, p.URL)
	}
	return out
}

// UsesOwnPort reports whether the proc asks for an assigned port (`${port}`
// anywhere in its spec).
func UsesOwnPort(p *Proc) bool {
	for _, text := range templated(p) {
		for _, match := range portTemplate.FindAllStringSubmatchIndex(text, -1) {
			if match[2] < 0 {
				return true
			}
		}
	}
	return false
}

func portRefs(p *Proc) []string {
	var refs []string
	for _, text := range templated(p) {
		for _, match := range portTemplate.FindAllStringSubmatch(text, -1) {
			if match[1] != "" {
				refs = append(refs, match[1])
			}
		}
	}
	return refs
}

// Resolve substitutes `${port}` / `${port:id}` with the ports assigned at
// startup. When internal maps this proc's id (the HTTP observer interposes on
// its assigned port), self references in shell / cmd / env resolve to the
// hidden internal port the proc must actually bind, while `${port:x}` cross
// references and the URL keep the public port — that is where the service is
// reachable, through the observer. Unresolvable templates stay as written.
func Resolve(p Proc, assigned, internal map[string]int) Proc {
	sub := func(text string, own int, hasOwn bool) string {
		return portTemplate.ReplaceAllStringFunc(text, func(whole string) string {
			ref := portTemplate.FindStringSubmatch(whole)[1]
			var port int
			var ok bool
			switch {
			case (ref == "" || ref == p.ID) && hasOwn:
				port, ok = own, true
			case ref == "" || ref == p.ID:
				port, ok = assigned[p.ID]
			default:
				port, ok = assigned[ref]
			}
			if !ok {
				return whole
			}
			return strconv.Itoa(port)
		})
	}
	own, hasOwn := internal[p.ID]
	bind := func(text string) string { return sub(text, own, hasOwn) }

	resolved := p
	resolved.Shell = bind(p.Shell)
	if p.Cmd != nil {
		resolved.Cmd = make([]string, len(p.Cmd))
		for i, arg := range p.Cmd {
			resolved.Cmd[i] = bind(arg)
		}
	}
	if p.Env != nil {
		resolved.Env = make(map[string]string, len(p.Env))
		for key, value := range p.Env {
			resolved.Env[key] = bind(value)
		}
	}
	resolved.URL = sub(p.URL, 0, false)
	return resolved
}

// FileNames are the config files looked for, in order. A legacy TS/JS config
// is still found, so Load can explain the move instead of "no config here".
var FileNames = []string{
	"procdeck.config.json",
	"procdeck.config.jsonc",
	"procdeck.config.ts",
	"procdeck.config.js",
	"procdeck.config.mjs",
}

// Discover returns the first config file present in dir, or "".
func Discover(dir string) string {
	for _, name := range FileNames {
		candidate := filepath.Join(dir, name)
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}
	return ""
}

// Locate finds the nearest config walking up from dir — so `procdeck
// up|down|open` work from anywhere inside the project, the way git finds its
// root.
func Locate(dir string) string {
	current, err := filepath.Abs(dir)
	if err != nil {
		return ""
	}
	for {
		if found := Discover(current); found != "" {
			return found
		}
		parent := filepath.Dir(current)
		if parent == current {
			return ""
		}
		current = parent
	}
}

// Error is a config problem, reported against its file.
type Error struct {
	File string
	Msg  string
}

func (e *Error) Error() string { return e.File + ": " + e.Msg }

// Loaded is a validated config and where it came from.
type Loaded struct {
	Config *Config
	// File is the config's real path.
	File string
	// Root is the config file's directory — the project's identity and the
	// default cwd of every process.
	Root string
	// Name is Config.Name, or Root's basename.
	Name string
}

// Dir is the working directory of a proc: its cwd resolved against the deck
// root (never against procdeck's own cwd), else the root.
func (l *Loaded) Dir(p *Proc) string {
	if p.Cwd == "" {
		return l.Root
	}
	if filepath.IsAbs(p.Cwd) {
		return p.Cwd
	}
	return filepath.Join(l.Root, p.Cwd)
}

// EnvFiles are the config's env files as absolute paths.
func (l *Loaded) EnvFiles() []string {
	paths := make([]string, len(l.Config.EnvFile))
	for i, file := range l.Config.EnvFile {
		if filepath.IsAbs(file) {
			paths[i] = file
		} else {
			paths[i] = filepath.Join(l.Root, file)
		}
	}
	return paths
}

// Load reads, parses and validates a config file.
func Load(file string) (*Loaded, error) {
	absolute, err := filepath.Abs(file)
	if err != nil {
		return nil, &Error{File: file, Msg: err.Error()}
	}
	// The real path, so the root (the project's identity in the registry)
	// does not depend on whether the config was reached through a symlink.
	real, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, &Error{File: absolute, Msg: "config file not found"}
	}
	switch filepath.Ext(real) {
	case ".ts", ".js", ".mjs":
		return nil, &Error{
			File: real,
			Msg:  "procdeck 2 reads JSON configs only — move this deck to procdeck.config.jsonc (comments and trailing commas are allowed)",
		}
	}
	data, err := os.ReadFile(real)
	if err != nil {
		return nil, &Error{File: real, Msg: err.Error()}
	}
	config, err := Parse(data)
	if err != nil {
		return nil, &Error{File: real, Msg: err.Error()}
	}
	root := filepath.Dir(real)
	name := config.Name
	if name == "" {
		name = filepath.Base(root)
	}
	return &Loaded{Config: config, File: real, Root: root, Name: name}, nil
}
