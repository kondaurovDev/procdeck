---
"procdeck": patch
---

HTTP observer forwards standard proxy headers and propagates connection failures faithfully:

- `x-forwarded-host` now carries the original Host (an outer proxy's value wins), so frameworks that CSRF-check Origin against the forwarded host — Next.js Server Actions — no longer reject mutating requests. `x-forwarded-proto` and `x-forwarded-for` are set too.
- A client abort (closed tab, cancelled fetch) now destroys the upstream request instead of letting it stream to completion unseen.
- An upstream dying mid-body truncates the client response by cutting the connection, instead of hanging the client or corrupting the payload with an appended error note.
