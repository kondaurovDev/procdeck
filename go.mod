module github.com/kondaurovDev/procdeck

go 1.26.0

// The TypeScript parts (the UI, the end-to-end suites, the npm package) and
// the example carry node_modules; keep `./...` out of them.
ignore (
	./e2e
	./example
	./node_modules
	./packages
	./ui
)

require (
	github.com/creack/pty v1.1.24
	github.com/modelcontextprotocol/go-sdk v1.8.0
	github.com/spf13/cobra v1.10.2
	github.com/tailscale/hujson v0.0.0-20260727124030-b80ff77dac4f
	golang.org/x/sys v0.49.0
)

require (
	github.com/google/jsonschema-go v0.4.3 // indirect
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/segmentio/asm v1.1.3 // indirect
	github.com/segmentio/encoding v0.5.4 // indirect
	github.com/spf13/pflag v1.0.9 // indirect
	github.com/yosida95/uritemplate/v3 v3.0.2 // indirect
	golang.org/x/oauth2 v0.35.0 // indirect
	golang.org/x/sync v0.20.0 // indirect
	golang.org/x/time v0.15.0 // indirect
)
