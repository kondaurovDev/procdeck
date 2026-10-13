package registry

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func setup(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("PROCDECK_HOME", home)
	return home
}

func instance(root string, over func(*Instance)) Instance {
	i := Instance{
		ID:        ID(root),
		Name:      filepath.Base(root),
		Root:      root,
		Config:    filepath.Join(root, "procdeck.config.json"),
		Port:      4820,
		Pid:       os.Getpid(),
		Log:       LogPath(root),
		StartedAt: time.Now().UnixMilli(),
		Version:   "0.0.0-test",
		Mode:      Detached,
	}
	if over != nil {
		over(&i)
	}
	return i
}

func names(instances []Instance) []string {
	out := []string{}
	for _, i := range instances {
		out = append(out, i.Name)
	}
	return out
}

func TestIDs(t *testing.T) {
	if ID("/a/b") != ID("/a/b/") || ID("/a/b") == ID("/a/c") || len(ID("/a/b")) != 12 {
		t.Fatalf("ids: %q %q %q", ID("/a/b"), ID("/a/b/"), ID("/a/c"))
	}
	// Byte-compatible with procdeck 1.x: sha1 of the path, first 12 hex chars.
	if got := ID("/proj/alpha"); got != "d2d8f6a7143b" {
		t.Fatalf("ID(/proj/alpha) = %q, procdeck 1.x says d2d8f6a7143b", got)
	}
}

func TestRegisterFindListDeregister(t *testing.T) {
	setup(t)
	if err := Register(instance("/proj/alpha", nil)); err != nil {
		t.Fatal(err)
	}
	Register(instance("/proj/beta", func(i *Instance) { i.Port = 4830 }))

	if found, ok := Find("/proj/alpha"); !ok || found.Name != "alpha" {
		t.Fatalf("Find alpha = %+v, %v", found, ok)
	}
	if _, ok := Find("/proj/gamma"); ok {
		t.Fatal("Find gamma succeeded")
	}
	if got := names(List()); !slices.Equal(got, []string{"alpha", "beta"}) {
		t.Fatalf("List = %q", got)
	}
	if found, ok := FindByPort(4830); !ok || found.Name != "beta" {
		t.Fatalf("FindByPort = %+v", found)
	}
	if _, ok := FindByPort(1); ok {
		t.Fatal("FindByPort(1) succeeded")
	}

	Deregister(ID("/proj/alpha"), os.Getpid())
	if _, ok := Find("/proj/alpha"); ok {
		t.Fatal("alpha survived Deregister")
	}
	if got := names(List()); !slices.Equal(got, []string{"beta"}) {
		t.Fatalf("List after deregister = %q", got)
	}
}

func TestPrunesDeadEntries(t *testing.T) {
	home := setup(t)
	// A pid that cannot be alive: the max on Linux is 4194304, macOS far lower.
	Register(instance("/proj/dead", func(i *Instance) { i.Pid = 2_000_000_000 }))
	Register(instance("/proj/live", nil))
	if files, _ := os.ReadDir(filepath.Join(home, "instances")); len(files) != 2 {
		t.Fatalf("%d files before pruning", len(files))
	}
	if got := names(List()); !slices.Equal(got, []string{"live"}) {
		t.Fatalf("List = %q", got)
	}
	if files, _ := os.ReadDir(filepath.Join(home, "instances")); len(files) != 1 {
		t.Fatalf("%d files after pruning", len(files))
	}
	if _, ok := Find("/proj/dead"); ok {
		t.Fatal("Find returned a dead deck")
	}
}

func TestDeregisterLeavesNewerRegistration(t *testing.T) {
	setup(t)
	Register(instance("/proj/x", nil))
	// Someone else re-registered the same root (a restart raced us).
	Register(instance("/proj/x", func(i *Instance) { i.Pid = os.Getppid() }))
	Deregister(ID("/proj/x"), os.Getpid())
	if found, ok := Find("/proj/x"); !ok || found.Pid != os.Getppid() {
		t.Fatalf("Find = %+v, %v", found, ok)
	}
}
