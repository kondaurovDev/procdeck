---
"procdeck": minor
---

procdeck runs in the background now. `procdeck up` (and bare `procdeck`) starts the
deck detached, opens the UI and returns — no terminal tab kept hostage; `up --fg` is
the old foreground mode. New commands, all working from anywhere inside the project:
`down` (terminates every process tree), `restart`, `status`, `ls` (every running deck
on the machine), `open` and `logs [-f]`. Running decks register in
`~/.procdeck/instances/` (stale entries pruned by pid; `PROCDECK_HOME` relocates it);
a detached deck's own output goes to `~/.procdeck/logs/`. `up` refuses a port already
held by another deck — naming it — or simply busy, before anything spawns; a bad
config is reported in the terminal, not in a log file. In the UI: ⏻ shuts the deck
down (with a confirm), the page says so instead of "reconnecting" and revives itself
when `procdeck up` runs again; the deck name in the bar lists the other running decks
as links. The CLI moved to `effect/unstable/cli` — `--help` per command, shell
completions via `--completions`.
