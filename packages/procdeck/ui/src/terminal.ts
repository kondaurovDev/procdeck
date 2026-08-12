import { Effect, Queue, Schema as S, Stream } from "effect"
import { Mount } from "foldkit"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { SearchAddon } from "@xterm/addon-search"
import { MountedTerminal, TypedInput } from "./message.ts"

type Entry = { term: Terminal; fit: FitAddon; search: SearchAddon }

/**
 * The imperative side of the page. xterm owns its DOM and its scrollback —
 * neither can be re-rendered from the Model, so instances live in this
 * module-level registry; Commands write into them, the Mount below creates
 * them. (Not a foldkit Resource: Mount streams must not require services —
 * their R channel is pinned to never.)
 */
export const registry = new Map<string, Entry>()

type TerminalMessage = typeof MountedTerminal.Type | typeof TypedInput.Type

/**
 * Mount: the seam where the declarative view hands a live element to xterm.
 * `defineStream` because keystrokes are a continuum — every chunk the user
 * types becomes a TypedInput Message and flows through update like anything
 * else.
 */
export const MountTerminal = Mount.defineStream(
  "MountTerminal",
  { id: S.String },
  MountedTerminal,
  TypedInput,
)(
  ({ id }) =>
    (element) =>
      Stream.callback<TerminalMessage>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const term = new Terminal({
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 12,
              scrollback: 10_000,
              theme: { background: "#0e1116", foreground: "#d8dee9" },
            })
            const fit = new FitAddon()
            term.loadAddon(fit)
            const search = new SearchAddon()
            term.loadAddon(search)
            term.open(element as HTMLElement)
            term.onData((data) => {
              Queue.offerUnsafe(queue, TypedInput({ id, data }))
            })
            // xterm keeps the viewport pinned when the user scrolls up; this
            // overlay is the way back down once new output lands off-screen.
            const toBottom = document.createElement("button")
            toBottom.className = "to-bottom"
            toBottom.textContent = "↓ output below"
            toBottom.hidden = true
            toBottom.addEventListener("click", () => term.scrollToBottom())
            ;(element as HTMLElement).appendChild(toBottom)
            const syncToBottom = () => {
              const buffer = term.buffer.active
              toBottom.hidden = buffer.viewportY >= buffer.baseY
            }
            term.onScroll(syncToBottom)
            term.onWriteParsed(syncToBottom)
            registry.set(id, { term, fit, search })
            Queue.offerUnsafe(queue, MountedTerminal({ id }))
            return term
          }),
          (term) =>
            Effect.sync(() => {
              registry.delete(id)
              term.dispose()
            }),
        ),
      ),
)
