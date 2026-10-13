package mcpserver

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// connect runs the server against an in-memory client session.
func connect(t *testing.T, mutations bool) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	if _, err := New("test", mutations).Connect(ctx, serverTransport, nil); err != nil {
		t.Fatal(err)
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil)
	session, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { session.Close() })
	return session
}

func toolNames(t *testing.T, session *mcp.ClientSession) []string {
	t.Helper()
	result, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range result.Tools {
		names = append(names, tool.Name)
	}
	slices.Sort(names)
	return names
}

func TestReadOnlyByDefault(t *testing.T) {
	want := []string{"deck_status", "get_errors", "get_http", "get_logs", "set_mark", "timeline", "wait_for"}
	if got := toolNames(t, connect(t, false)); !slices.Equal(got, want) {
		t.Fatalf("tools = %q", got)
	}
	got := toolNames(t, connect(t, true))
	for _, name := range []string{"restart_proc", "stop_proc", "start_proc"} {
		if !slices.Contains(got, name) {
			t.Errorf("--mutations lacks %s: %q", name, got)
		}
	}
}

func TestInputSchemasComeFromTheStructs(t *testing.T) {
	result, _ := connect(t, false).ListTools(context.Background(), nil)
	for _, tool := range result.Tools {
		if tool.Name != "wait_for" {
			continue
		}
		schema, _ := tool.InputSchema.(map[string]any)
		required, _ := schema["required"].([]any)
		if len(required) != 1 || required[0] != "proc" {
			t.Fatalf("wait_for schema = %v", schema)
		}
		if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
			t.Error("wait_for should be annotated read-only")
		}
	}
}

func TestNoDeckIsAToolErrorTheAgentCanRead(t *testing.T) {
	t.Chdir(t.TempDir())
	result, err := connect(t, false).CallTool(context.Background(), &mcp.CallToolParams{Name: "deck_status"})
	if err != nil {
		t.Fatalf("a missing deck must not be a protocol error: %v", err)
	}
	text := result.Content[0].(*mcp.TextContent).Text
	if !result.IsError || !strings.Contains(text, "no procdeck config found") {
		t.Fatalf("result = %+v (%q)", result, text)
	}
}
