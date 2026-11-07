# Output buffers: per proc, by bytes, with a seam marker

A fresh browser tab needs each pane's recent history. The first design kept
one shared ring of events, "the last 5000 events in total", and that was the
wrong shape: a chatty proc (a per-second ticker, a verbose watcher) evicted
quiet procs' history, a quiet server's startup lines were the first to go,
and the UI could not tell replayed chunks from live ones.

## Decision

- **One backlog per proc, bounded by bytes** (256 KB, `backlogBytes` in
  `internal/supervisor`), not by event count — chunks vary wildly in size.
  Eviction in one pane cannot touch another.
- **Chunks carry a per-proc `seq`.** A subscriber's snapshot and its live
  feed are built under the same lock, so they meet with no gap and no
  duplicate — the supervisor publishes every event while holding `mu`, and
  `Subscribe` takes its snapshot under it.
- **An explicit end-of-backlog marker.** A subscription delivers, per proc,
  the backlog chunks and the current status, then `{type: "synced"}`, then
  live events. The UI treats everything before `synced` as history: no unread
  badges, no notifications, terminals reset before the replay lands. That
  replaced a "chunks within 500 ms of open are backlog" heuristic.
- **Status is not in the ring.** Each proc's current status rides along with
  its snapshot, so a chatty neighbour cannot evict the one event that says
  "crashed".

The terminal backlog is what a pane replays; it holds raw PTY bytes. Its
machine-readable twin is `internal/lines`: per-proc **line** buffers with ANSI
stripped and `\r` progress bars reduced to their final state, byte-bounded the
same way, cursored by their own `seq` — what `procdeck logs`, `errors`, marks
and `wait-for` read (see [agent-harness.md](agent-harness.md)). The captured
traffic in `internal/httplog` follows the same per-proc ring pattern.

A slow subscriber (a stalled tab) drops its oldest undelivered live events
past 4096 rather than holding up the deck; on reconnect the snapshot brings
it back to the current state.
