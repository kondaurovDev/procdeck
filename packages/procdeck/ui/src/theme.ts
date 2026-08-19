import { Effect, Queue, Stream } from "effect"
import type { ITheme } from "@xterm/xterm"
import { SystemSchemeChanged } from "./message.ts"
import type { Message } from "./message.ts"
import type { Model, Scheme } from "./model.ts"

/**
 * Theme = the user's preference (system/light/dark); scheme = what is on
 * screen right now (light/dark). The page CSS resolves both by itself —
 * `prefers-color-scheme` for system, `[data-theme]` for an explicit pick, set
 * before first paint by the inline script in index.html — so the UI only has
 * to keep the parts CSS cannot reach in step: xterm's palette and the
 * theme-color meta (ApplyTheme in command.ts). This module is the data side.
 */
export const resolveScheme = (model: Model): Scheme =>
  model.theme === "system" ? (model.systemDark ? "dark" : "light") : model.theme

const darkQuery = () => window.matchMedia("(prefers-color-scheme: dark)")

export const systemPrefersDark = (): boolean => darkQuery().matches

/** The scheme the document is currently painted in — for code that runs outside `update`. */
export const currentScheme = (): Scheme => {
  const explicit = document.documentElement.dataset["theme"]
  return explicit === "light" || explicit === "dark"
    ? explicit
    : systemPrefersDark()
      ? "dark"
      : "light"
}

/**
 * xterm palettes. Dark keeps xterm's default ANSI (tuned for dark
 * backgrounds); light gets a full palette — the default bright yellow/cyan
 * are unreadable on white. Light is GitHub Light's ANSI, page colours match
 * the CSS tokens in styles.css.
 */
const XTERM_THEMES: Record<Scheme, ITheme> = {
  dark: {
    background: "#0e1116",
    foreground: "#d8dee9",
    cursor: "#d8dee9",
    selectionBackground: "#4c9aff55",
  },
  light: {
    background: "#ffffff",
    foreground: "#1f2328",
    cursor: "#1f2328",
    selectionBackground: "#0969da40",
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#4d2d00",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
}

export const xtermTheme = (scheme: Scheme): ITheme => XTERM_THEMES[scheme]

/** Browser chrome colour (tab strip / installed window title bar); matches `--panel`. */
export const THEME_COLOR: Record<Scheme, string> = { dark: "#151a21", light: "#f6f8fa" }

/** The OS switching light/dark under us — matters while the preference is "system". */
export const systemSchemeStream: Stream.Stream<Message> = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const query = darkQuery()
      const onChange = (event: MediaQueryListEvent) => {
        Queue.offerUnsafe(queue, SystemSchemeChanged({ dark: event.matches }))
      }
      query.addEventListener("change", onChange)
      return { query, onChange }
    }),
    ({ query, onChange }) => Effect.sync(() => query.removeEventListener("change", onChange)),
  ),
)
