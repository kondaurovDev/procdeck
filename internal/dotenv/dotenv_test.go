package dotenv

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	vars, err := Parse(strings.Join([]string{
		"# a comment",
		"",
		"PLAIN=value",
		"SPACED = padded value   ",
		"export EXPORTED=yes",
		"EMPTY=",
		"INLINE=kept # dropped",
		"HASH=no#comment",
		`DOUBLE="line one\nline two \"quoted\""`,
		`SINGLE='literal \n stays'`,
		"BACKTICK=`it's fine`",
		`QUOTED_COMMENT="value" # trailing comment`,
		`MULTI="first`,
		`second"`,
		"DOTTED.KEY-1=ok",
		"WINDOWS=crlf\r",
	}, "\n"))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"PLAIN":          "value",
		"SPACED":         "padded value",
		"EXPORTED":       "yes",
		"EMPTY":          "",
		"INLINE":         "kept",
		"HASH":           "no#comment",
		"DOUBLE":         "line one\nline two \"quoted\"",
		"SINGLE":         `literal \n stays`,
		"BACKTICK":       "it's fine",
		"QUOTED_COMMENT": "value",
		"MULTI":          "first\nsecond",
		"DOTTED.KEY-1":   "ok",
		"WINDOWS":        "crlf",
	}
	if !reflect.DeepEqual(vars, want) {
		t.Errorf("vars = %#v", vars)
	}
}

func TestParseErrorsNameTheLine(t *testing.T) {
	cases := map[string]string{
		"A=1\nnot a pair":    "line 2",
		"A=1\nB=\"open":      "line 2: unterminated",
		"1BAD=x":             "line 1",
		`A="closed" garbage`: "after the closing quote",
	}
	for src, want := range cases {
		if _, err := Parse(src); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Parse(%q) = %v, want %q", src, err, want)
		}
	}
}

func TestLoadLayersFilesAndSkipsMissing(t *testing.T) {
	dir := t.TempDir()
	base := filepath.Join(dir, ".env")
	local := filepath.Join(dir, ".env.local")
	os.WriteFile(base, []byte("A=base\nB=base\n"), 0o644)
	os.WriteFile(local, []byte("B=local\n"), 0o644)
	vars, missing, err := Load(base, filepath.Join(dir, ".env.missing"), local)
	if err != nil {
		t.Fatal(err)
	}
	if vars["A"] != "base" || vars["B"] != "local" || len(missing) != 1 {
		t.Fatalf("vars = %v, missing = %v", vars, missing)
	}
	os.WriteFile(local, []byte("broken\n"), 0o644)
	if _, _, err := Load(local); err == nil || !strings.Contains(err.Error(), ".env.local: line 1") {
		t.Fatalf("err = %v", err)
	}
}
