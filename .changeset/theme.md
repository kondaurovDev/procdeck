---
"procdeck": patch
---

Light theme. A System · Light · Dark switch in the global bar; System follows the OS
(`prefers-color-scheme`) and tracks it live. The terminals switch palette too — light gets
its own ANSI set (GitHub Light), since xterm's defaults are unreadable on white. The choice
is stored with the rest of the UI state and painted before the first frame, so there is
no flash on reload.
