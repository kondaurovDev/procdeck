import { Schema as S } from "effect"
import { ProcInfo } from "./schema.ts"

export const Model = S.Struct({
  procs: S.Array(ProcInfo),
  /** Selected pane id. */
  active: S.UndefinedOr(S.String),
  /**
   * Ids whose xterm instance has mounted. The SSE subscription is gated on
   * every pane being mounted, so the replayed backlog always has somewhere to
   * land — ordering as a Model condition instead of imperative sequencing.
   */
  mounted: S.Array(S.String),
  error: S.UndefinedOr(S.String),
  /** Log search query; undefined means the search box is closed. */
  search: S.UndefinedOr(S.String),
  /**
   * Per-proc count of error-looking log lines that arrived while another pane
   * was visible. Cleared the moment the proc is selected.
   */
  unread: S.Record(S.String, S.Number),
  /** Wall clock driving the uptime display; advanced by Ticked. */
  now: S.Number,
})
export type Model = typeof Model.Type
