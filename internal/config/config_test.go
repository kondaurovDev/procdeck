package config

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func mustParse(t *testing.T, source string) *Config {
	t.Helper()
	config, err := Parse([]byte(source))
	if err != nil {
		t.Fatalf("Parse(%s): %v", source, err)
	}
	return config
}

func parseError(t *testing.T, source, want string) {
	t.Helper()
	_, err := Parse([]byte(source))
	if err == nil {
		t.Fatalf("Parse(%s): no error, want %q", source, want)
	}
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("Parse(%s): error %q, want it to contain %q", source, err, want)
	}
}

// parseErrorMatching is parseError for an error whose exact wording varies.
func parseErrorMatching(t *testing.T, source, pattern string) {
	t.Helper()
	_, err := Parse([]byte(source))
	if err == nil {
		t.Fatalf("Parse(%s): no error, want one matching %q", source, pattern)
	}
	if !regexp.MustCompile(pattern).MatchString(err.Error()) {
		t.Fatalf("Parse(%s): error %q, want it to match %q", source, err, pattern)
	}
}

func TestAcceptsFullConfig(t *testing.T) {
	config := mustParse(t, `{
		"port": 4820,
		"procs": [
			{ "id": "web", "shell": "pnpm dev", "url": "http://localhost:2025" },
			{ "id": "api", "cmd": ["node", "server.js"], "autostart": false, "env": { "DEBUG": "1" } }
		]
	}`)
	if len(config.Procs) != 2 || config.Procs[1].Autostarts() || !config.Procs[0].Autostarts() {
		t.Fatalf("procs = %+v", config.Procs)
	}
}

func TestAcceptsCommentsAndTrailingCommas(t *testing.T) {
	config := mustParse(t, `{
		// the deck's UI
		"port": 4840,
		"procs": [
			/* the api */ { "id": "api", "shell": "serve", },
		],
	}`)
	if config.UIPort() != 4840 || config.Procs[0].ID != "api" {
		t.Fatalf("config = %+v", config)
	}
}

func TestRejectsMalformed(t *testing.T) {
	parseError(t, `{"port": 1}`, `missing "procs"`)
	// encoding/json names the element in the path from Go 1.27 on
	// (procs.0.id); before, only the field (procs.id).
	parseErrorMatching(t, `{"procs": [{"id": 42, "shell": "x"}]}`, `^procs(\.0)?\.id: expected string, got number$`)
	parseError(t, `{"procs": [{"id": "x", "shell": "x", "env": {"A": 1}}]}`, "expected string")
	parseError(t, `{"procs": [{"id": "x", "shell": "x", "need": ["y"]}]}`, `unknown field "need"`)
	parseError(t, `{ procs: [ }`, "")
}

func TestRejectsGraphProblems(t *testing.T) {
	parseError(t, `{"procs": [{"id": "a", "shell": "x", "needs": ["ghost"]}]}`, `proc "a" needs unknown proc "ghost"`)
	parseError(t, `{"procs": [
		{"id": "a", "shell": "x", "needs": ["b"]},
		{"id": "b", "shell": "x", "needs": ["a"]}
	]}`, "dependency cycle")
	parseError(t, `{"procs": [{"id": "a", "shell": "x"}, {"id": "a", "shell": "y"}]}`, "duplicate proc ids")
}

func TestPreflightAndAlerts(t *testing.T) {
	config := mustParse(t, `{"procs": [{
		"id": "api", "shell": "pnpm dev",
		"preflight": { "shell": "wrangler whoami", "hint": "run pnpm cloudflare:login" },
		"alerts": [{ "pattern": "Opening a link", "label": "needs login" }]
	}]}`)
	if config.Procs[0].Preflight.Hint != "run pnpm cloudflare:login" || len(config.Procs[0].Alerts) != 1 {
		t.Fatalf("proc = %+v", config.Procs[0])
	}
	parseError(t, `{"procs": [{"id": "x", "shell": "x", "alerts": [{"pattern": "(", "label": "bad"}]}]}`,
		"expected a valid regular expression")
}

func TestShellXorCmd(t *testing.T) {
	parseError(t, `{"procs": [{"id": "x"}]}`, "expected exactly one of `shell` or `cmd`")
	parseError(t, `{"procs": [{"id": "x", "shell": "a", "cmd": ["b"]}]}`, "expected exactly one of `shell` or `cmd`")
	parseError(t, `{"procs": [{"id": "x", "cmd": []}]}`, "must not be empty")
}

func TestPortTemplates(t *testing.T) {
	config := mustParse(t, `{"procs": [
		{"id": "api", "shell": "serve --port ${port}", "url": "http://localhost:${port}"},
		{"id": "web", "shell": "web", "env": {"API_URL": "http://localhost:${port:api}"}}
	]}`)
	if !UsesOwnPort(&config.Procs[0]) || UsesOwnPort(&config.Procs[1]) {
		t.Fatal("UsesOwnPort misreads ${port} vs ${port:api}")
	}
	parseError(t, `{"procs": [{"id": "web", "shell": "web ${port:ghost}"}]}`, `no proc "ghost"`)
	parseError(t, `{"procs": [
		{"id": "api", "shell": "serve --port 3000"},
		{"id": "web", "shell": "web ${port:api}"}
	]}`, `"api" does not use ${port} itself`)
}

func TestPinnedPorts(t *testing.T) {
	config := mustParse(t, `{"procs": [{"id": "api", "shell": "serve --port ${port}", "port": 8787}]}`)
	if *config.Procs[0].Port != 8787 {
		t.Fatalf("pin = %d", *config.Procs[0].Port)
	}
	parseError(t, `{"procs": [{"id": "api", "shell": "serve --port 8787", "port": 8787}]}`, "does not use ${port}")
	parseError(t, `{"procs": [
		{"id": "a", "shell": "a ${port}", "port": 8787},
		{"id": "b", "shell": "b ${port}", "port": 8787}
	]}`, "same port 8787")
	parseError(t, `{"port": 5000, "procs": [{"id": "a", "shell": "a ${port}", "port": 5000}]}`, "UI's own port")
	parseError(t, `{"procs": [{"id": "a", "shell": "a ${port}", "port": 4820}]}`, "UI's own port")
	parseError(t, `{"procs": [{"id": "a", "shell": "a ${port}", "port": 80.5}]}`, "expected int")
	parseError(t, `{"procs": [{"id": "a", "shell": "a ${port}", "port": 0}]}`, "out of range")
	parseError(t, `{"procs": [{"id": "a", "shell": "a ${port}", "port": 65536}]}`, "out of range")
}

func TestResolve(t *testing.T) {
	config := mustParse(t, `{"procs": [
		{"id": "api", "cmd": ["serve", "--port", "${port}"], "url": "http://localhost:${port}"},
		{"id": "web", "shell": "web --port ${port}", "env": {"API_URL": "http://localhost:${port:api}"}}
	]}`)
	assigned := map[string]int{"api": 50001, "web": 50002}
	api := Resolve(config.Procs[0], assigned, nil)
	web := Resolve(config.Procs[1], assigned, nil)
	if !slices.Equal(api.Cmd, []string{"serve", "--port", "50001"}) || api.URL != "http://localhost:50001" {
		t.Errorf("api = %+v", api)
	}
	if web.Shell != "web --port 50002" || web.Env["API_URL"] != "http://localhost:50001" {
		t.Errorf("web = %+v", web)
	}
	// The original spec is untouched — Resolve copies slices and maps.
	if config.Procs[0].Cmd[2] != "${port}" || config.Procs[1].Env["API_URL"] != "http://localhost:${port:api}" {
		t.Error("Resolve mutated its input")
	}

	if got := Resolve(Proc{ID: "a", Shell: "x ${port}"}, map[string]int{}, nil).Shell; got != "x ${port}" {
		t.Errorf("unresolvable template = %q", got)
	}
}

func TestResolveWithInternalPorts(t *testing.T) {
	config := mustParse(t, `{"procs": [
		{"id": "api", "cmd": ["serve", "--port", "${port}"], "env": {"SELF": "http://localhost:${port:api}"}, "url": "http://localhost:${port}"},
		{"id": "web", "shell": "web ${port}", "env": {"API_URL": "http://localhost:${port:api}"}}
	]}`)
	assigned := map[string]int{"api": 50001, "web": 50002}
	internal := map[string]int{"api": 60001, "web": 60002}
	api := Resolve(config.Procs[0], assigned, internal)
	web := Resolve(config.Procs[1], assigned, internal)
	// The proc binds the hidden internal port, explicit self-references
	// included…
	if !slices.Equal(api.Cmd, []string{"serve", "--port", "60001"}) || api.Env["SELF"] != "http://localhost:60001" {
		t.Errorf("api binds = %+v", api)
	}
	// …but the world reaches it on the public one, through the observer.
	if api.URL != "http://localhost:50001" || web.Env["API_URL"] != "http://localhost:50001" || web.Shell != "web 60002" {
		t.Errorf("public side: api.URL = %q, web = %+v", api.URL, web)
	}
}

func writeDeck(t *testing.T, root, name, contents string) string {
	t.Helper()
	file := filepath.Join(root, name)
	if err := os.WriteFile(file, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
	return file
}

// tempRoot is a real path: macOS hands out /var/… temp dirs that are
// symlinks to /private/var/….
func tempRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func TestLoad(t *testing.T) {
	root := tempRoot(t)
	file := writeDeck(t, root, "procdeck.config.json",
		`{"$schema": "https://unpkg.com/procdeck/schema.json", "name": "json-deck", "procs": [{"id": "api", "shell": "serve --port ${port}"}]}`)
	loaded, err := Load(file)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Name != "json-deck" || len(loaded.Config.Procs) != 1 || loaded.Root != root {
		t.Fatalf("loaded = %+v", loaded)
	}
}

func TestLoadNamesDeckAfterDirectory(t *testing.T) {
	root := tempRoot(t)
	loaded, err := Load(writeDeck(t, root, "procdeck.config.jsonc", `{"procs": []}`))
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Name != filepath.Base(root) {
		t.Fatalf("name = %q", loaded.Name)
	}
}

func TestLoadErrorsNameTheFile(t *testing.T) {
	root := tempRoot(t)
	file := writeDeck(t, root, "procdeck.config.json", `{"procs": [{"id": "web", "shell": "web", "needs": ["ghost"]}]}`)
	_, err := Load(file)
	if err == nil || !strings.HasPrefix(err.Error(), file+": ") || !strings.Contains(err.Error(), "unknown proc") {
		t.Fatalf("err = %v", err)
	}
	if _, err := Load(filepath.Join(root, "missing.json")); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("missing: err = %v", err)
	}
	legacy := writeDeck(t, root, "procdeck.config.ts", "export default {}")
	if _, err := Load(legacy); err == nil || !strings.Contains(err.Error(), "procdeck.config.jsonc") {
		t.Fatalf("legacy: err = %v", err)
	}
}

func TestDiscover(t *testing.T) {
	root := tempRoot(t)
	if Discover(root) != "" {
		t.Fatal("empty dir has a config")
	}
	writeDeck(t, root, "procdeck.config.ts", "export default {}")
	if got := Discover(root); got != filepath.Join(root, "procdeck.config.ts") {
		t.Fatalf("legacy only: %q", got)
	}
	writeDeck(t, root, "procdeck.config.jsonc", "{}")
	if got := Discover(root); got != filepath.Join(root, "procdeck.config.jsonc") {
		t.Fatalf("JSONC over TS: %q", got)
	}
	writeDeck(t, root, "procdeck.config.json", "{}")
	if got := Discover(root); got != filepath.Join(root, "procdeck.config.json") {
		t.Fatalf("JSON first: %q", got)
	}

	nested := filepath.Join(root, "a", "b")
	os.MkdirAll(nested, 0o755)
	if got := Locate(nested); got != filepath.Join(root, "procdeck.config.json") {
		t.Fatalf("Locate from a subdirectory: %q", got)
	}
}

func TestProcDir(t *testing.T) {
	loaded := &Loaded{Root: "/deck"}
	cases := map[string]string{"": "/deck", "packages/api": "/deck/packages/api", "/abs": "/abs"}
	for cwd, want := range cases {
		if got := loaded.Dir(&Proc{Cwd: cwd}); got != want {
			t.Errorf("Dir(cwd=%q) = %q, want %q", cwd, got, want)
		}
	}
}

func TestEnvFile(t *testing.T) {
	one := mustParse(t, `{"envFile": ".env", "procs": []}`)
	many := mustParse(t, `{"envFile": [".env", "/abs/.env.local"], "procs": []}`)
	if len(one.EnvFile) != 1 || len(many.EnvFile) != 2 {
		t.Fatalf("one = %q, many = %q", one.EnvFile, many.EnvFile)
	}
	loaded := &Loaded{Root: "/deck", Config: many}
	if got := loaded.EnvFiles(); got[0] != "/deck/.env" || got[1] != "/abs/.env.local" {
		t.Errorf("EnvFiles = %q", got)
	}
	parseError(t, `{"envFile": 42, "procs": []}`, "envFile: expected a path or a list of paths")
	parseError(t, `{"envFile": "", "procs": []}`, "must not be empty")
}
