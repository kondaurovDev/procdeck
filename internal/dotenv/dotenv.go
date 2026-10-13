// Package dotenv reads .env files — the format Node's --env-file and the
// dotenv libraries share: KEY=value lines, `export` prefixes, `#` comments,
// single, double and backtick quotes, and multi-line values inside quotes.
// No variable expansion: a value means what it says.
package dotenv

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"regexp"
	"strings"
)

var key = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]*$`)

// Parse reads the variables of one file's contents.
func Parse(src string) (map[string]string, error) {
	vars := map[string]string{}
	rest := strings.ReplaceAll(src, "\r\n", "\n")
	line := 0
	for rest != "" {
		var raw string
		raw, rest, _ = strings.Cut(rest, "\n")
		line++
		text := strings.TrimSpace(raw)
		if text == "" || strings.HasPrefix(text, "#") {
			continue
		}
		text = strings.TrimSpace(strings.TrimPrefix(text, "export "))
		name, value, ok := strings.Cut(text, "=")
		name = strings.TrimSpace(name)
		if !ok || !key.MatchString(name) {
			return nil, fmt.Errorf("line %d: expected KEY=value", line)
		}
		value = strings.TrimLeft(value, " \t")

		if value != "" && strings.ContainsRune("\"'`", rune(value[0])) {
			quote := value[0]
			body := value[1:]
			// A quoted value may run over several lines.
			for {
				if end := closing(body, quote); end >= 0 {
					if trailing := strings.TrimSpace(body[end+1:]); trailing != "" && !strings.HasPrefix(trailing, "#") {
						return nil, fmt.Errorf("line %d: unexpected %q after the closing quote", line, trailing)
					}
					body = body[:end]
					break
				}
				if rest == "" {
					return nil, fmt.Errorf("line %d: unterminated %c quote", line, quote)
				}
				var next string
				next, rest, _ = strings.Cut(rest, "\n")
				line++
				body += "\n" + next
			}
			if quote == '"' {
				body = unescape(body)
			}
			vars[name] = body
			continue
		}

		// Unquoted: a comment starts at a `#` preceded by whitespace.
		if i := strings.Index(value, " #"); i >= 0 {
			value = value[:i]
		}
		if i := strings.Index(value, "\t#"); i >= 0 {
			value = value[:i]
		}
		vars[name] = strings.TrimSpace(value)
	}
	return vars, nil
}

// closing finds the quote that ends a value, skipping escaped double quotes.
func closing(body string, quote byte) int {
	for i := 0; i < len(body); i++ {
		switch {
		case quote == '"' && body[i] == '\\':
			i++
		case body[i] == quote:
			return i
		}
	}
	return -1
}

var escapes = strings.NewReplacer(`\n`, "\n", `\r`, "\r", `\t`, "\t", `\"`, `"`, `\\`, `\`)

func unescape(s string) string { return escapes.Replace(s) }

// Load reads the files in order — a later file overrides an earlier one.
// Files that do not exist are skipped and reported in missing.
func Load(paths ...string) (vars map[string]string, missing []string, err error) {
	vars = map[string]string{}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if errors.Is(err, fs.ErrNotExist) {
			missing = append(missing, path)
			continue
		}
		if err != nil {
			return nil, nil, err
		}
		parsed, err := Parse(string(data))
		if err != nil {
			return nil, nil, fmt.Errorf("%s: %w", path, err)
		}
		for name, value := range parsed {
			vars[name] = value
		}
	}
	return vars, missing, nil
}
