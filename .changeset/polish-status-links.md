---
"procdeck": patch
---

Polish before publishing, part one.

- URLs in pane output are clickable (`Local: http://localhost:5173/` from every dev
  server opens in a new tab).
- Exit status reads like a human wrote it: `exit 1 · 2m ago`, `killed (SIGTERM) · 5s ago`
  — signal names instead of numbers, and no more `signal 0` on a plain non-zero exit.
  Running procs that were respawned show a restart count (`↻3`), so crash loops are
  visible from the status line. The sidebar shows the same exit summary where uptime sits
  while running.
- Grid tile headers keep the `*.localhost` address whole instead of clipping it to `:61`:
  compact tiles show only the primary address (raw ports in its tooltip) and the status
  text is what gives way first.
- The assigned port no longer also counts as "internal" when it lands in the ephemeral
  range.
