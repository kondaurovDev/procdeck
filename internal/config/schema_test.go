package config

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// schema.json is maintained by hand for editors; these structs are what the
// loader enforces. The test keeps the two from drifting apart: every field a
// config may carry is described, and nothing described is rejected.

type schemaNode struct {
	Properties map[string]schemaNode `json:"properties"`
	Items      *schemaNode           `json:"items"`
	// AdditionalProperties is `false` or a schema (env's string values).
	AdditionalProperties json.RawMessage `json:"additionalProperties"`
}

func jsonFields(t reflect.Type) []string {
	var names []string
	for field := range t.Fields() {
		name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		if name != "" && name != "-" {
			names = append(names, name)
		}
	}
	slices.Sort(names)
	return names
}

func propertyNames(node schemaNode) []string {
	var names []string
	for name := range node.Properties {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

func TestSchemaMatchesTheStructs(t *testing.T) {
	data, err := os.ReadFile("../../schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var root schemaNode
	if err := json.Unmarshal(data, &root); err != nil {
		t.Fatal(err)
	}
	proc := *root.Properties["procs"].Items
	nodes := map[string]struct {
		node schemaNode
		typ  reflect.Type
	}{
		"config":    {root, reflect.TypeFor[Config]()},
		"proc":      {proc, reflect.TypeFor[Proc]()},
		"preflight": {proc.Properties["preflight"], reflect.TypeFor[Preflight]()},
		"alert":     {*proc.Properties["alerts"].Items, reflect.TypeFor[Alert]()},
	}
	for name, n := range nodes {
		if got, want := propertyNames(n.node), jsonFields(n.typ); !slices.Equal(got, want) {
			t.Errorf("%s: schema.json describes %q, the struct has %q", name, got, want)
		}
		// Unknown keys are errors at load time; editors should say so too.
		if string(n.node.AdditionalProperties) != "false" {
			t.Errorf("%s: schema.json must set additionalProperties: false", name)
		}
	}
}
