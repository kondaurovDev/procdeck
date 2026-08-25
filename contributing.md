# Contributing

Thanks for looking. Bug reports and small, focused pull requests are welcome;
for anything larger, open an issue first so we can agree on the shape before
you write it.

## Getting set up

You need **Node ≥ 22.18** (native type stripping — the server runs as `.ts` in
dev), **pnpm 11** and macOS or Linux. Windows is not supported: procdeck leans
on PTYs, `pgrep` and `lsof`.

```sh
pnpm install      # also patches the Effect language service into tsc
pnpm dev          # builds the UI and starts the example stack in the foreground
```

`pnpm dev` is the fastest way to see a change: the example under
[`example/`](example/) exercises every feature — assigned ports, dependencies,
a preflight gate, alerts, HTTP and WebSocket traffic.

For the UI alone, `pnpm --filter procdeck ui:dev` runs vite against a deck you
started separately.

## The checks

These four are exactly what CI runs, and all of them must pass:

```sh
pnpm lint          # oxlint
pnpm format:check  # oxfmt — `pnpm format` writes
pnpm check:types   # tsc, including the Effect language service diagnostics
pnpm test          # vitest
```

The tests spawn real (tiny) processes — `node -e` one-liners and shells with
background children — because the risks live at the OS boundary: PTY
detection, process-group kills, SIGTERM-ignoring survivors, scope teardown.
Mocking that would test the mock. They need a real PTY (`/dev/ptmx`), so they
will not run inside a sandbox that blocks PTY allocation.

## Style

- oxfmt decides formatting: no semicolons, no trailing commas. Do not fight it.
- Comments explain _why_, not what. The code says what.
- User-facing prose for config fields belongs in `Schema` annotations in
  [`config.ts`](packages/procdeck/src/config.ts), never in JSDoc: `schema.json`
  is generated from those annotations, so JSON configs, editor tooltips and
  runtime validation cannot drift apart.
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
