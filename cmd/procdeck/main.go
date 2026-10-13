// Command procdeck is the dev-process multiplexer: terminal panes in a
// browser tab, declarative dependencies, assigned ports, and a CLI for humans
// and coding agents.
package main

import (
	"os"

	"github.com/kondaurovDev/procdeck/internal/cli"
)

func main() {
	os.Exit(cli.Execute(os.Args[1:]))
}
