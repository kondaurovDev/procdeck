// Package discover is how a coding agent learns procdeck exists.
//
// MCP tools are self-describing, but the plain CLI is invisible until
// something tells the agent about it. `procdeck agents` (and `procdeck init`
// when the project already has agent instructions) plants that knowledge: a
// short section in CLAUDE.md / AGENTS.md ("know I exist, ask status first")
// and a Claude Code skill teaching the whole verify loop. The same workflow
// text as the MCP tool descriptions — distributed into the project instead of
// served over the protocol.
package discover

import (
	_ "embed"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// marker is the snippet's heading; it doubles as the idempotency marker.
const marker = "## procdeck"

// Snippet is the section appended to CLAUDE.md / AGENTS.md.
//
//go:embed snippet.md
var Snippet string

// Skill is the Claude Code skill file.
//
//go:embed skill.md
var Skill string

// FindInstructionsFile returns the instructions file to extend: CLAUDE.md,
// else AGENTS.md, else "".
func FindInstructionsFile(root string) string {
	for _, name := range []string{"CLAUDE.md", "AGENTS.md"} {
		file := filepath.Join(root, name)
		if _, err := os.Stat(file); err == nil {
			return file
		}
	}
	return ""
}

// AppendSnippet appends the snippet once; it reports false when the
// `## procdeck` heading says it is already there.
func AppendSnippet(file string) (appended bool, err error) {
	current, err := os.ReadFile(file)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	text := string(current)
	if strings.Contains(text, marker) {
		return false, nil
	}
	glue := "\n\n"
	switch {
	case text == "", strings.HasSuffix(text, "\n\n"):
		glue = ""
	case strings.HasSuffix(text, "\n"):
		glue = "\n"
	}
	out, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return false, err
	}
	if _, err := out.WriteString(glue + Snippet); err != nil {
		out.Close()
		return false, err
	}
	return true, out.Close()
}

// WriteSkill writes the Claude Code skill; an existing one is left alone.
func WriteSkill(root string) (file string, written bool, err error) {
	dir := filepath.Join(root, ".claude", "skills", "procdeck")
	file = filepath.Join(dir, "SKILL.md")
	if _, err := os.Stat(file); err == nil {
		return file, false, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return file, false, err
	}
	return file, true, os.WriteFile(file, []byte(Skill), 0o644)
}

// SetupAgents is `procdeck agents`: both rungs of the discovery ladder.
// Idempotent — running it twice changes nothing. It returns human-readable
// action lines.
func SetupAgents(root string) ([]string, error) {
	instructions := FindInstructionsFile(root)
	if instructions == "" {
		instructions = filepath.Join(root, "CLAUDE.md")
	}
	appended, err := AppendSnippet(instructions)
	if err != nil {
		return nil, err
	}
	name := filepath.Base(instructions)
	actions := []string{name + ` — already has a "## procdeck" section, left as is`}
	if appended {
		actions[0] = name + ` — added a "## procdeck" section`
	}

	_, written, err := WriteSkill(root)
	if err != nil {
		return actions, err
	}
	if written {
		actions = append(actions, ".claude/skills/procdeck/SKILL.md — written (teaches the mark → act → since-mark loop)")
	} else {
		actions = append(actions, ".claude/skills/procdeck/SKILL.md — already there, left as is")
	}
	return actions, nil
}
