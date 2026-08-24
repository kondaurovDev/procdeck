---
"procdeck": minor
---

`procdeck restart --all` restarts every deck on this machine — stop, then detach again
from each deck's own registry entry (foreground decks are skipped). The version a deck
actually runs now shows in `status`, `ls` and the UI's deck switcher, and `status`/`up`
say so out loud when it differs from the CLI — the answer to "did my update reach this
deck?".
