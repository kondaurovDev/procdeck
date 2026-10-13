package supervisor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kondaurovDev/procdeck/internal/config"
)

func TestEnvFileReachesProcsAndPreflights(t *testing.T) {
	root := t.TempDir()
	envFile := filepath.Join(root, ".env")
	os.WriteFile(envFile, []byte("FROM_FILE=one\nOVERRIDDEN=file\n"), 0o644)
	s, err := Start(&config.Loaded{Root: root, Config: &config.Config{
		EnvFile: config.EnvFiles{".env", ".env.missing"},
		Procs: []config.Proc{
			{
				ID:    "gated",
				Shell: `echo "gated sees $FROM_FILE"; exec sleep 1000`,
				// The preflight needs the file's variables too — the wrangler
				// token case.
				Preflight: &config.Preflight{Shell: `test "$FROM_FILE" = one`},
			},
			{
				ID:    "plain",
				Shell: `echo "file=$FROM_FILE over=$OVERRIDDEN"; exec sleep 1000`,
				// The proc's own env wins over the file.
				Env: map[string]string{"OVERRIDDEN": "spec"},
			},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)

	events := subscribe(t, s)
	events.untilAll("both procs up, the missing file noted",
		func(e Event) bool { return e.Type == EventLog && strings.Contains(e.Data, "gated sees one") },
		func(e Event) bool { return e.Type == EventLog && strings.Contains(e.Data, "file=one over=spec") },
		func(e Event) bool {
			return e.Type == EventLog && e.ID == "plain" && strings.Contains(e.Data, "env file .env.missing not found")
		},
	)

	// The file is read at every spawn: a refreshed one reaches the proc on its
	// next restart, no deck restart needed.
	os.WriteFile(envFile, []byte("FROM_FILE=two\n"), 0o644)
	s.Restart("plain")
	events.until("the refreshed value", func(e Event) bool {
		return e.Type == EventLog && strings.Contains(e.Data, "file=two")
	})
}

func TestMalformedEnvFileFailsTheSpawn(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, ".env"), []byte("OK=1\nnot a pair\n"), 0o644)
	s, err := Start(&config.Loaded{Root: root, Config: &config.Config{
		EnvFile: config.EnvFiles{".env"},
		Procs:   []config.Proc{{ID: "app", Shell: longRunner}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	events := subscribe(t, s)
	events.until("the reason in the pane", func(e Event) bool {
		return e.Type == EventLog && strings.Contains(e.Data, "env file .env: line 2")
	})
	if st := status(s, "app"); st.State != Exited || *st.ExitCode != -1 {
		t.Fatalf("app = %+v", st)
	}
}
