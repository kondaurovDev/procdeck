// Package webui embeds the built browser UI into the binary. The UI itself is
// the vite app in ui/; its build writes straight into dist here.
package webui

import (
	"embed"
	"io/fs"
)

//go:generate pnpm --dir ../../ui run build

//go:embed all:dist
var files embed.FS

// FS is the UI build, rooted at its index.html.
func FS() fs.FS {
	dist, err := fs.Sub(files, "dist")
	if err != nil {
		panic(err)
	}
	return dist
}
