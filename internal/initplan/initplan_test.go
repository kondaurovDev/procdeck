package initplan

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/kondaurovDev/procdeck/internal/config"
)

func write(t *testing.T, root, relative string, content any) {
	t.Helper()
	file := filepath.Join(root, relative)
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	data, ok := content.(string)
	if !ok {
		encoded, _ := json.Marshal(content)
		data = string(encoded)
	}
	if err := os.WriteFile(file, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
}

type obj = map[string]any

// mustLoad checks that whatever init writes loads as a deck.
func mustLoad(t *testing.T, plan Plan) {
	t.Helper()
	data, _ := json.Marshal(plan.Config)
	if _, err := config.Parse(data); err != nil {
		t.Fatalf("generated config does not load: %v\n%s", err, data)
	}
}

func checkProcs(t *testing.T, plan Plan, want []Proc) {
	t.Helper()
	if !reflect.DeepEqual(plan.Config.Procs, want) {
		t.Fatalf("procs = %+v\nwant  %+v", plan.Config.Procs, want)
	}
}

func TestPNPMWorkspace(t *testing.T) {
	root := t.TempDir()
	write(t, root, "package.json", obj{"name": "@acme/monorepo", "private": true})
	write(t, root, "pnpm-lock.yaml", "lockfileVersion: 9\n")
	write(t, root, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n  - apps/**\n  - '!**/test/**'\n")
	write(t, root, "packages/api/package.json", obj{"name": "@acme/api", "scripts": obj{"dev": "node server.js"}})
	write(t, root, "packages/shared/package.json", obj{"name": "@acme/shared", "scripts": obj{"build": "tsc"}})
	write(t, root, "apps/web/package.json", obj{"name": "web", "scripts": obj{"dev": "vite"}})
	write(t, root, "apps/docs/package.json", obj{"name": "docs", "scripts": obj{"start": "astro dev"}})

	plan := Detect(root)
	if plan.Config.Name != "monorepo" {
		t.Errorf("name = %q", plan.Config.Name)
	}
	// Workspace glob order, then directory order; ids drop the scope.
	checkProcs(t, plan, []Proc{
		{ID: "api", Shell: "pnpm --filter @acme/api dev"},
		{ID: "docs", Shell: "pnpm --filter docs start"},
		{ID: "web", Shell: "pnpm --filter web dev"},
	})
	mustLoad(t, plan)
	if !strings.Contains(strings.Join(plan.Notes, "\n"), "apps/web") {
		t.Errorf("notes = %q", plan.Notes)
	}
}

func TestYarnWorkspacesFromPackageJSON(t *testing.T) {
	root := t.TempDir()
	write(t, root, "package.json", obj{"name": "shop", "workspaces": []string{"services/*"}, "scripts": obj{"dev": "turbo dev"}})
	write(t, root, "yarn.lock", "")
	write(t, root, "services/api/package.json", obj{"name": "api", "scripts": obj{"dev": "nest start --watch"}})
	write(t, root, "services/worker/package.json", obj{"name": "worker", "scripts": obj{"start:dev": "tsx w.ts"}})
	// Same name twice in different dirs must not collide.
	write(t, root, "services/api2/package.json", obj{"name": "api", "scripts": obj{"dev": "x"}})

	plan := Detect(root)
	// The root's own `dev` is not added on top of the per-package panes.
	checkProcs(t, plan, []Proc{
		{ID: "api", Shell: "yarn workspace api dev"},
		{ID: "api-2", Shell: "yarn workspace api dev"},
		{ID: "worker", Shell: "yarn workspace worker start:dev"},
	})
	mustLoad(t, plan)
}

func TestWorkspacesObjectForm(t *testing.T) {
	root := t.TempDir()
	write(t, root, "package.json", obj{"name": "shop", "workspaces": obj{"packages": []string{"apps/*"}}})
	write(t, root, "apps/web/package.json", obj{"name": "web", "scripts": obj{"dev": "vite"}})
	checkProcs(t, Detect(root), []Proc{{ID: "web", Shell: "npm run dev -w web"}})
}

func TestSinglePackage(t *testing.T) {
	root := t.TempDir()
	write(t, root, "package.json", obj{"name": "@me/blog", "scripts": obj{"dev": "next dev", "build": "next build"}})
	write(t, root, "package-lock.json", "{}")
	plan := Detect(root)
	if plan.Config.Name != "blog" {
		t.Errorf("name = %q", plan.Config.Name)
	}
	checkProcs(t, plan, []Proc{{ID: "blog", Shell: "npm run dev"}})
	mustLoad(t, plan)
}

func TestPlainSubdirectories(t *testing.T) {
	root := t.TempDir()
	write(t, root, "backend/package.json", obj{"name": "backend", "scripts": obj{"dev": "nodemon"}})
	write(t, root, "backend/pnpm-lock.yaml", "")
	write(t, root, "frontend/package.json", obj{"name": "@shop/frontend", "scripts": obj{"dev": "vite"}})
	write(t, root, "frontend/yarn.lock", "")
	write(t, root, "ml/manage.py", "")
	write(t, root, "gateway/go.mod", "module gateway\n")
	write(t, root, "docs/README.md", "nothing runnable here")
	write(t, root, "node_modules/left-pad/package.json", obj{"name": "left-pad", "scripts": obj{"dev": "no"}})
	// A root dev script that merely fans out — the per-directory panes win.
	write(t, root, "package.json", obj{"name": "shop", "scripts": obj{"dev": "concurrently ..."}})
	write(t, root, "package-lock.json", "{}")

	plan := Detect(root)
	if plan.Source != FromSubdirectories {
		t.Errorf("source = %q", plan.Source)
	}
	checkProcs(t, plan, []Proc{
		{ID: "backend", Shell: "pnpm run dev", Cwd: "backend"},
		{ID: "frontend", Shell: "yarn run dev", Cwd: "frontend"},
		{ID: "gateway", Shell: "go run .", Cwd: "gateway"},
		{ID: "ml", Shell: "python manage.py runserver", Cwd: "ml"},
	})
	mustLoad(t, plan)
}

func TestSubdirectoryUsesRootManager(t *testing.T) {
	root := t.TempDir()
	write(t, root, "pnpm-lock.yaml", "")
	write(t, root, "api/package.json", obj{"name": "api", "scripts": obj{"dev": "tsx watch src"}})
	checkProcs(t, Detect(root), []Proc{{ID: "api", Shell: "pnpm run dev", Cwd: "api"}})
}

func TestProcfileWins(t *testing.T) {
	root := t.TempDir()
	write(t, root, "Procfile", "web: bundle exec puma -C config/puma.rb\n# a comment\nworker: bundle exec sidekiq\n\n")
	write(t, root, "bin/rails", "#!/usr/bin/env ruby")
	write(t, root, "package.json", obj{"name": "app", "scripts": obj{"dev": "vite"}})
	plan := Detect(root)
	if plan.Source != FromProcfile {
		t.Errorf("source = %q", plan.Source)
	}
	checkProcs(t, plan, []Proc{
		{ID: "web", Shell: "bundle exec puma -C config/puma.rb"},
		{ID: "worker", Shell: "bundle exec sidekiq"},
	})
	mustLoad(t, plan)
}

func TestNonJSRoot(t *testing.T) {
	root := t.TempDir()
	write(t, root, "Cargo.toml", "[package]\nname = \"svc\"\n")
	plan := Detect(root)
	if plan.Source != FromRoot {
		t.Errorf("source = %q", plan.Source)
	}
	checkProcs(t, plan, []Proc{{ID: strings.ToLower(filepath.Base(root)), Shell: "cargo run"}})

	// docker compose at the root, no code of our own → compose it is.
	os.Remove(filepath.Join(root, "Cargo.toml"))
	write(t, root, "compose.yaml", "services: {}")
	if got := Detect(root).Config.Procs[0].Shell; got != "docker compose up" {
		t.Errorf("compose: %q", got)
	}
}

func TestTemplate(t *testing.T) {
	root := t.TempDir()
	plan := Detect(root)
	if plan.Source != FromTemplate || plan.Config.Name != filepath.Base(root) || len(plan.Config.Procs) != 1 {
		t.Fatalf("plan = %+v", plan)
	}
	if !strings.Contains(plan.Notes[0], "nothing recognisable") {
		t.Errorf("notes = %q", plan.Notes)
	}
	mustLoad(t, plan)
}
