module github.com/kondaurovDev/procdeck

go 1.26.0

// The TypeScript parts (the UI, the end-to-end suites, the npm package) and
// the example carry node_modules; keep `./...` out of them.
ignore (
	./e2e
	./example
	./node_modules
	./npm
	./ui
)

require (
	github.com/creack/pty v1.1.24
	github.com/spf13/cobra v1.10.2
	github.com/tailscale/hujson v0.0.0-20260727124030-b80ff77dac4f
	golang.org/x/sys v0.49.0
)

require (
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/spf13/pflag v1.0.9 // indirect
)
