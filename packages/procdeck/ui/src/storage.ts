import { Effect, Option as O, Schema as S } from "effect"
import { Command } from "foldkit"
import { CompletedRequest } from "./message.ts"
import { Layout } from "./model.ts"

/**
 * The slice of the Model that survives a reload. localStorage is keyed per
 * origin, and origin includes the port, so every deck keeps its own state
 * with no namespacing on our side. Every field is optional on read: an older
 * or hand-edited value must never blank the UI. See docs/plan.md, "UI state
 * survives a refresh".
 */
export const UiState = S.Struct({
  layout: S.optionalKey(Layout),
  active: S.optionalKey(S.String),
})
export type UiState = typeof UiState.Type

const KEY = "procdeck.ui"

const decode = S.decodeUnknownOption(UiState)

/** Best effort: private mode, quota, or garbage all read as "nothing stored". */
export const loadUiState = (): UiState => {
  try {
    const raw = localStorage.getItem(KEY)
    return raw === null ? {} : O.getOrElse(decode(JSON.parse(raw)), () => ({}))
  } catch {
    return {}
  }
}

/** Emitted by `update` whenever a persisted field changes; one Command for all of them. */
export const SaveUiState = Command.define("SaveUiState", {
  args: { layout: Layout, active: S.UndefinedOr(S.String) },
  messages: [CompletedRequest],
  execute: (state) =>
    Effect.sync(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(state))
      } catch {
        // Storage unavailable — the UI still works, it just won't remember.
      }
      return CompletedRequest()
    }),
})
