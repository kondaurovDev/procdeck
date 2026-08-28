---
"procdeck": minor
---

A proc can pin its assigned `${port}` to a fixed public number: `port: 8787`
on the spec. The public side stays exactly that number — dotenv files, mobile
simulators and teammates' scripts keep their hardcoded `localhost:8787` —
while an observed proc still binds a hidden internal port behind the HTTP
observer, so the traffic gets captured with no wiring changes anywhere.
Conflicting pins (duplicate, on the UI's port, or on a proc that never uses
`${port}`) are config errors; a pin whose port is already taken parks just
that proc in `blocked` — naming the port and the likely holder — while the
rest of the deck runs, and Start retries the bind. A pinned proc with no
`url` also gets its UI link derived from the pin.
