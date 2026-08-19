---
"procdeck": minor
---

Three things for the first real release. **Loopback only:** the server binds
`127.0.0.1` by default — the UI types into real terminals, so it is not something to
put on the LAN by accident; `"host": "0.0.0.0"` in the config opens it up for
devcontainers and VMs. **Per-proc backlog:** each proc keeps its last 256 KB of output
and a new tab gets every pane's history plus a `synced` marker before live events — a
chatty ticker can no longer evict a quiet server's startup lines, a deck that has run
for days still opens with every pane populated, the UI knows exactly which chunks are
news, and a reconnect replays into freshly reset panes instead of appending history to
itself. **`procdeck init`:** writes a first `procdeck.config.json` from what is already there —
a Procfile, workspace packages with `dev` scripts (via the package manager your lockfile
points at), plain `backend/` + `frontend/` subdirectories (each its own package.json or
a Django / Go / Rust / Rails / compose project, with `cwd` set), or the root itself.
