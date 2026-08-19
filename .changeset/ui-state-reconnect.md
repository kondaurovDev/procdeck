---
"procdeck": patch
---

The UI remembers itself across reloads, and says when it has lost the server.

Layout (single/grid) and the selected pane are kept in localStorage — per origin, so per
deck — and restored on the next load; a stored pane that is no longer in the config falls
back to the first one. While the event stream is down (a `procdeck restart`, a killed
server) a "reconnecting" banner sits over the panes instead of the UI silently showing
stale state; when the stream is back the proc snapshot is refetched so statuses that
changed in the meantime catch up. A stream the browser gave up on (server answered with
something other than an event stream) is retried every 2 s.
