# Contributing

Thanks for looking. Bug reports and small, focused pull requests are welcome;
for anything larger, open an issue first so we can agree on the shape before
you write it.

## Getting set up

You need **Go ≥ 1.26** (procdeck itself), **Node ≥ 22** and **pnpm 11** (the
UI builds with vite; the end-to-end suites and the example's servers run on
Node) and macOS or Linux. Windows is not supported: procdeck leans on PTYs,
`ps` and `lsof`.

```sh
pnpm install      # also patches the Effect language service into tsc
pnpm dev          # builds the UI, embeds it and runs the example stack on the Go procdeck
```

`pnpm dev` is the fastest way to see a change: the example under
[`example/`](example/) exercises every feature — assigned ports, dependencies,
a preflight gate, alerts, HTTP and WebSocket traffic.

For the UI alone, `pnpm --filter @procdeck/ui dev` runs vite against a deck
you started separately.

## The checks

These are what CI runs, and all of them must pass:

```sh
pnpm lint          # oxlint + go vet
pnpm format:check  # oxfmt + gofmt — `pnpm format` writes
pnpm check:types   # tsc for the UI and the e2e suites
pnpm test          # go test -race ./..., then the e2e suites against a fresh build
```

The tests spawn real (tiny) processes — shells with background children, the
Go test binary re-run as a helper server, `node -e` one-liners in the e2e
suites — because the risks live at the OS boundary: PTY detection,
process-group kills, SIGTERM-ignoring survivors, teardown. Mocking that would
test the mock. They need a real PTY (`/dev/ptmx`), so they will not run inside
a sandbox that blocks PTY allocation.

[`e2e/`](e2e/) drives the built binary from the outside — the CLI, the HTTP
API, an MCP session — and builds it first unless `PROCDECK_BIN` names one.

## Style

- oxfmt decides formatting: no semicolons, no trailing commas. Do not fight it.
- Comments explain _why_, not what. The code says what.
- User-facing prose for config fields belongs in [`schema.json`](schema.json):
  it is what editors show. A field added to the Go structs in
  [`internal/config`](internal/config/) needs its entry there —
  `TestSchemaMatchesTheStructs` fails until the two agree.
- New capability? It usually needs three surfaces kept in step: the CLI verb,
  the MCP tool, and the docs page.

[`docs/architecture.md`](docs/architecture.md) maps the codebase — read it
before a change that crosses files.

## Changesets

Anything a user would notice needs a changeset:

```sh
pnpm changeset
```

Pick `patch` / `minor` / `major` and describe the change the way a release note
would — what it does for the person using it, not which functions moved.
Releases are automatic: merging to `main` opens a release PR, and merging that
publishes to npm.

Internal-only changes (refactors, tests, tooling) need no changeset.

## Pull requests

- Branch off `main`, keep the diff to one concern.
- Say why in the description; link the issue if there is one.
- Update the docs in the same PR — a feature that is not in
  [`docs/`](docs/) does not exist for anyone but you.
- Commit messages: a short imperative subject, then the reasoning. Look at
  `git log` for the register.
