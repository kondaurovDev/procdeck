---
"procdeck": patch
---

Grid pinning. Pin a proc (📌 in its pane header or sidebar row, ⌥P on the active one) and
the grid shows only pinned procs; the rest collapse into a tray strip under the tiles —
status dot, id, badges — where a click peeks at one and the pin puts it back. Nothing
pinned = everyone tiled, as before. ⌥Z zooms the active tile in and out of single. The
grid now sizes its columns from the tile count (near-square, at most 4) so the deck fits
the screen when it can and scrolls only when tiles would drop under 180 px. Pins persist
with the rest of the UI state.
