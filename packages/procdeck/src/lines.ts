/**
 * Per-proc line buffers — the machine-readable twin of the chunk backlog.
 *
 * The chunk backlog in the supervisor is terminal-oriented: raw PTY output,
 * ANSI escapes and all, replayed into xterm. Agents (and the grep filter, the
 * merged view, `procdeck errors`) want *lines*: plain text, timestamped,
 * individually addressable by a per-proc `seq`. One buffer per proc, bounded
 * by bytes like the chunk backlog, so a chatty neighbour can't evict anyone
 * else's history.
 */

export type LogLine = {
  /** Per-proc line counter — stable cursor for "everything after seq N". */
  seq: number
  /** Epoch ms of the chunk that completed the line. */
  ts: number
  text: string
}

/** A line attributed to its proc — what multi-proc queries return. */
export type DeckLogLine = LogLine & { proc: string }

export type LogsQuery = {
  /** Proc ids to include; undefined = every proc. */
  procs?: Array<string> | undefined
  /** Per-proc: only lines with `seq >= sinceSeq[proc]` (a mark snapshot). */
  sinceSeq?: Record<string, number> | undefined
  /** Only lines completed at or after this epoch ms. */
  sinceMs?: number | undefined
  /** Only lines completed at or before this epoch ms — with `sinceMs`, a
   * window "around T": what was every proc doing at that moment? */
  untilMs?: number | undefined
  /** RegExp source matched against each line (case-insensitive). */
  grep?: string | undefined
  /** Max lines returned — the *tail* of the matches. */
  limit: number
}

export type LogsResult = {
  lines: Array<DeckLogLine>
  /** Per requested proc: the seq the next line will get — a resume cursor. */
  nextSeq: Record<string, number>
  /** Matching lines dropped by `limit` (the oldest ones). */
  omitted: number
}

/** A named position in every proc's line stream — "now", to diff against. */
export type Mark = {
  name: string
  at: number
  seqs: Record<string, number>
}

// CSI (colors, cursor), OSC (titles, links), DCS/PM/APC strings, then any
// stray two-byte escape. Order matters: the specific forms go first so the
// catch-all can't eat their introducers.
const ANSI =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[()#%*+][0-9A-Za-z@]|\x1b./g

/** C0 controls that survive escape stripping, except \t \n \r. */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

export const stripAnsi = (text: string): string =>
  text.replace(ANSI, "").replace(CONTROLS, "")

/** Byte budget per proc — same order as the chunk backlog's 256 KB. */
const BUFFER_BYTES = 256 * 1024
/** A single line past this is flushed in pieces — no unbounded partials. */
const MAX_LINE = 4096

export class LineBuffer {
  private lines: Array<LogLine> = []
  private bytes = 0
  private partial = ""
  private seq = 0

  /** The seq the next completed line will get. */
  get nextSeq(): number {
    return this.seq
  }

  /**
   * Feed a PTY chunk. `\r\n` and `\n` complete a line; a lone `\r` *discards*
   * the partial — carriage-return progress bars overwrite themselves in a
   * terminal, and keeping only the final state is exactly what a reader
   * wants (and what keeps a ticking progress bar from flooding the buffer).
   */
  push(data: string, ts: number): void {
    for (const token of stripAnsi(data).split(/(\r\n|\r|\n)/)) {
      if (token === "\r\n" || token === "\n") {
        this.complete(ts)
      } else if (token === "\r") {
        this.partial = ""
      } else if (token !== "") {
        this.partial += token
        if (this.partial.length >= MAX_LINE) this.complete(ts)
      }
    }
  }

  private complete(ts: number): void {
    const text = this.partial.trimEnd()
    this.partial = ""
    this.lines.push({ seq: this.seq++, ts, text })
    this.bytes += text.length + 1
    while (this.bytes > BUFFER_BYTES && this.lines.length > 1) {
      this.bytes -= this.lines.shift()!.text.length + 1
    }
  }

  /** Lines within the given cursors/window, oldest first. */
  slice(
    options: {
      sinceSeq?: number | undefined
      sinceMs?: number | undefined
      untilMs?: number | undefined
    } = {},
  ): Array<LogLine> {
    const { sinceMs, sinceSeq, untilMs } = options
    return this.lines.filter(
      (line) =>
        (sinceSeq === undefined || line.seq >= sinceSeq) &&
        (sinceMs === undefined || line.ts >= sinceMs) &&
        (untilMs === undefined || line.ts <= untilMs),
    )
  }
}

/**
 * One query over many procs' buffers: filter, interleave by time, keep the
 * tail. Throws on an invalid grep pattern or an unknown proc — callers turn
 * that into a 400 / a CLI failure.
 */
export const queryLogs = (
  buffers: Map<string, LineBuffer>,
  query: LogsQuery,
): LogsResult => {
  const ids = query.procs ?? [...buffers.keys()]
  const pattern = query.grep === undefined ? undefined : new RegExp(query.grep, "i")

  const matched: Array<DeckLogLine> = []
  const nextSeq: Record<string, number> = {}
  for (const id of ids) {
    const buffer = buffers.get(id)
    if (buffer === undefined) throw new Error(`unknown proc "${id}"`)
    nextSeq[id] = buffer.nextSeq
    for (const line of buffer.slice({
      sinceSeq: query.sinceSeq?.[id],
      sinceMs: query.sinceMs,
      untilMs: query.untilMs,
    })) {
      if (pattern === undefined || pattern.test(line.text)) {
        matched.push({ ...line, proc: id })
      }
    }
  }

  // Interleave by wall clock; same-millisecond ties keep a stable per-proc
  // order via seq. Cross-proc ordering inside one millisecond is arbitrary.
  matched.sort((a, b) => a.ts - b.ts || a.proc.localeCompare(b.proc) || a.seq - b.seq)

  const omitted = Math.max(0, matched.length - query.limit)
  return { lines: matched.slice(omitted), nextSeq, omitted }
}
