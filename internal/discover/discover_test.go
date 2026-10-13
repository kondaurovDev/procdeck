package discover

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func read(t *testing.T, file string) string {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestFindInstructionsFile(t *testing.T) {
	root := t.TempDir()
	if got := FindInstructionsFile(root); got != "" {
		t.Fatalf("empty dir: %q", got)
	}
	os.WriteFile(filepath.Join(root, "AGENTS.md"), []byte("# agents\n"), 0o644)
	if got := FindInstructionsFile(root); got != filepath.Join(root, "AGENTS.md") {
		t.Fatalf("AGENTS.md only: %q", got)
	}
	os.WriteFile(filepath.Join(root, "CLAUDE.md"), []byte("# claude\n"), 0o644)
	if got := FindInstructionsFile(root); got != filepath.Join(root, "CLAUDE.md") {
		t.Fatalf("CLAUDE.md wins: %q", got)
	}
}

func TestAppendSnippetOnce(t *testing.T) {
	file := filepath.Join(t.TempDir(), "CLAUDE.md")
	os.WriteFile(file, []byte("# my project\n\nSome rules.\n"), 0o644)
	if appended, err := AppendSnippet(file); err != nil || !appended {
		t.Fatalf("first append: %v, %v", appended, err)
	}
	content := read(t, file)
	for _, want := range []string{"# my project", "Some rules.\n\n## procdeck", "procdeck status --json"} {
		if !strings.Contains(content, want) {
			t.Errorf("content lacks %q", want)
		}
	}
	if appended, _ := AppendSnippet(file); appended {
		t.Error("second append changed the file")
	}
	if read(t, file) != content {
		t.Error("content changed on the second run")
	}
}

func TestSetupAgents(t *testing.T) {
	root := t.TempDir()
	first, err := SetupAgents(root)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(first, "\n")
	if !strings.Contains(joined, `CLAUDE.md — added a "## procdeck" section`) || !strings.Contains(joined, "SKILL.md — written") {
		t.Errorf("first run: %q", first)
	}
	if read(t, filepath.Join(root, "CLAUDE.md")) != Snippet {
		t.Error("a fresh CLAUDE.md is exactly the snippet")
	}
	skill := filepath.Join(root, ".claude", "skills", "procdeck", "SKILL.md")
	if read(t, skill) != Skill {
		t.Error("skill content differs")
	}

	again, _ := SetupAgents(root)
	joined = strings.Join(again, "\n")
	if !strings.Contains(joined, "already has") || !strings.Contains(joined, "already there") {
		t.Errorf("second run: %q", again)
	}

	// An existing skill file is never overwritten.
	os.WriteFile(skill, []byte("custom\n"), 0o644)
	SetupAgents(root)
	if read(t, skill) != "custom\n" {
		t.Error("custom skill overwritten")
	}
}

func TestSnippetAndSkillTeachTheSameVerbs(t *testing.T) {
	for _, text := range []string{Snippet, Skill} {
		for _, verb := range []string{"status --json", "logs", "errors", "mark", "wait-for", "--since-mark"} {
			if !strings.Contains(text, verb) {
				t.Errorf("text lacks %q", verb)
			}
		}
	}
	if !strings.HasPrefix(Skill, "---\nname: procdeck\ndescription:") {
		t.Error("the skill needs Claude Code frontmatter")
	}
}
