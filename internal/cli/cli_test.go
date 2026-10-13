package cli

import (
	"testing"
	"time"
)

func TestParseDuration(t *testing.T) {
	cases := map[string]time.Duration{
		"30s": 30 * time.Second, "5m": 5 * time.Minute, "2h": 2 * time.Hour, "1d": 24 * time.Hour,
		"250ms": 250 * time.Millisecond, "1.5m": 90 * time.Second, "45": 45 * time.Second, " 10s ": 10 * time.Second,
	}
	for raw, want := range cases {
		if got, ok := parseDuration(raw); !ok || got != want {
			t.Errorf("parseDuration(%q) = %v, %v", raw, got, ok)
		}
	}
	for _, raw := range []string{"", "soon", "5 minutes", "-1s"} {
		if _, ok := parseDuration(raw); ok {
			t.Errorf("parseDuration(%q) parsed", raw)
		}
	}
}

func TestDescribeUptime(t *testing.T) {
	ago := func(d time.Duration) int64 { return time.Now().Add(-d).UnixMilli() }
	cases := map[time.Duration]string{
		12 * time.Second:              "12s",
		5*time.Minute + 3*time.Second: "5m",
		2*time.Hour + 3*time.Minute:   "2h 3m",
		26*time.Hour + 10*time.Minute: "1d 2h",
		-time.Minute:                  "0s", // clock skew
	}
	for d, want := range cases {
		if got := describeUptime(ago(d)); got != want {
			t.Errorf("describeUptime(%v ago) = %q, want %q", d, got, want)
		}
	}
}

func TestTable(t *testing.T) {
	got := table([][]string{
		{"  api", "running", "http://api.localhost:4820", ""},
		{"  web", "exit 1", "http://web.localhost:4820", "⚠ needs login"},
	})
	want := "  api  running  http://api.localhost:4820\n" +
		"  web  exit 1   http://web.localhost:4820  ⚠ needs login"
	if got != want {
		t.Errorf("table:\n%s\nwant:\n%s", got, want)
	}
}
