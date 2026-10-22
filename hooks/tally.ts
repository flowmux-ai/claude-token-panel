import type { Row, Usage } from '../types'

// USD per million tokens at standard API rates, which an Enterprise plan bills
// usage at: [model id part, input, output, cache read]. The first match wins.
// A cache write costs 1.25x input (5 minutes) or 2x input (1 hour).
// ponytail: a table that rots, refresh it from platform.claude.com/docs/en/about-claude/pricing.
// Not priced: fast mode, US-only inference (1.1x), web search requests, Haiku 5.5's
// higher rate past a 100K-token prompt.
const RATES: readonly (readonly [string, number, number, number])[] = [
  ['claude-fable-5-1', 10, 50, 0.25],
  ['claude-mythos-5-1', 10, 50, 0.25],
  ['claude-fable-5', 10, 50, 1],
  ['claude-mythos-5', 10, 50, 1],
  ['claude-opus-5-5', 4, 20, 0.2],
  ['claude-opus-4-1', 15, 75, 1.5],
  // Opus 4, `claude-opus-4-20250514`: its date follows the version.
  ['claude-opus-4-2', 15, 75, 1.5],
  ['claude-opus', 5, 25, 0.5],
  ['claude-sonnet-5', 2, 10, 0.2],
  ['claude-sonnet', 3, 15, 0.3],
  ['claude-haiku-5-5', 0.1, 0.5, 0.01],
  ['claude-haiku-4-5', 1, 5, 0.1],
]

// A response's usage as the transcript stores it; `iterations` splits it per
// request when one response held several (an advisor's call names its own model).
type Use = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_1h_input_tokens?: number }
  model?: string
  iterations?: Use[] | null
}

// Adds `use` to the row, or with `sign` -1 takes it back.
const spend = (row: Row, model: string, use: Use, sign: 1 | -1): void => {
  const input = use.input_tokens ?? 0
  const output = use.output_tokens ?? 0
  const read = use.cache_read_input_tokens ?? 0
  const write = use.cache_creation_input_tokens ?? 0
  const hour = use.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const rate = RATES.find(([part]) => model.includes(part))

  row.input += sign * input
  row.output += sign * output
  row.cacheRead += sign * read
  row.cacheWrite += sign * write

  if (rate === undefined) {
    row.isUnpriced ||= input + output + read + write > 0

    return
  }

  const [, perInput, perOutput, perRead] = rate
  row.usd +=
    (sign *
      (input * perInput +
        (write - hour) * perInput * 1.25 +
        hour * perInput * 2 +
        read * perRead +
        output * perOutput)) /
    1e6
}

// A response's usage as the transcript stores it, counted toward a row at a model.
type Charge = { row: Row; model: string; usage: Use }

const charge = ({ row, model, usage }: Charge, sign: 1 | -1): void => {
  for (const use of usage.iterations?.length ? usage.iterations : [usage]) {
    spend(row, use.model ?? model, use, sign)
  }
}

/**
 * How far one transcript is counted: the bytes fed so far, the prompt the
 * next response falls in, and what each response counted. A response is
 * stored once per content block, and a subagent's first copy lacks its
 * output: a later copy counts in place of the earlier.
 */
export type Cursor = { at: number; row: Row | undefined; counted: Map<string, Charge> }

export const cursor = (): Cursor => ({ at: 0, row: undefined, counted: new Map() })

/**
 * Feeds `text`'s whole lines to `rows`, from the main transcript (`isMain`: a
 * prompt starts a row) or a subagent's (a prompt finds the row that spawned
 * it). Returns the bytes fed: a last line without its newline, still being
 * written or cut by a read, waits. Fed twice, lines count once.
 */
export const feed = (cursor: Cursor, rows: Row[], text: string, isMain: boolean): number => {
  const whole = text.slice(0, text.lastIndexOf('\n') + 1)

  for (const line of whole.split('\n')) {
    let entry

    try {
      entry = JSON.parse(line)
    } catch {
      // A blank line, or one cut short.
      continue
    }

    // A client-local command (/reload-plugins, /clear, …) echoes itself in a user entry but
    // runs no model turn; it is not a prompt. A model-invoking command keeps its expanded
    // prompt in a separate entry, so skipping the echo still leaves its row.
    const content: unknown = entry?.message?.content
    const isCommand = typeof content === 'string' && /^\s*<(command-|local-command-)/.test(content)

    // A meta entry (a slash command's caveat) is never drawn: the prompt's row takes the next one's uuid.
    if (
      entry?.type === 'user' &&
      entry.isMeta !== true &&
      !isCommand &&
      typeof entry.promptId === 'string' &&
      entry.promptId !== cursor.row?.id
    ) {
      let row = rows.find(known => known.id === entry.promptId)

      if (row === undefined && isMain) {
        row = {
          id: entry.promptId,
          uuid: String(entry.uuid),
          model: '',
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          usd: 0,
          other: 0,
          isUnpriced: false,
        }
        rows.push(row)
      }

      cursor.row = row
    }

    const message = entry?.type === 'assistant' ? entry.message : undefined

    if (!message?.usage) {
      continue
    }

    // A copy of a response counts toward the row its first copy did; a copy the same as the one counted (fed again) changes nothing.
    const was = cursor.counted.get(message.id)
    const owner = was?.row ?? cursor.row ?? rows.at(-1)

    if (owner === undefined || JSON.stringify(was?.usage) === JSON.stringify(message.usage)) {
      continue
    }

    const now: Charge = { row: owner, model: String(message.model), usage: message.usage }

    if (was !== undefined) {
      charge(was, -1)
    }

    charge(now, 1)
    cursor.counted.set(message.id, now)

    // The prompt's model is its own loop's last, never a subagent's or a made-up row's.
    if (isMain && !now.model.startsWith('<')) {
      owner.model = now.model.replace(/^.*claude-/, '').replace(/-\d{8}$/, '').slice(0, 9)
    }
  }

  return new TextEncoder().encode(whole).length
}

/**
 * The pane's state after a count: `rows` with each prompt's share of what the
 * engine billed beyond the transcripts. `engine` is the engine's cost total,
 * and `isNewPrompt` says a prompt was just submitted: growth up to here is
 * the earlier prompt's, growth from here the new one's.
 */
export const settle = (
  old: Usage,
  path: string,
  rows: Row[],
  engine: number | undefined,
  isNewPrompt: boolean,
): Usage => {
  if (engine === undefined) {
    return { ...old, path, rows, rest: 0 }
  }

  const gap = engine - rows.reduce((sum, row) => sum + row.usd, 0)
  const offset = old.offset ?? gap
  const grown = gap - offset
  const mark = isNewPrompt ? grown : old.mark
  const marks = { ...old.marks }

  for (const row of rows) {
    marks[row.id] ??= mark
  }

  rows.forEach((row, i) => {
    const next = rows[i + 1]
    const end = next === undefined ? grown : (marks[next.id] ?? grown)
    // A count taken between the engine's bill and the transcript's row can dip below zero.
    row.other = Math.max(0, end - (marks[row.id] ?? end))
  })

  // Never below zero: a resumed session's engine total may not cover its earlier prompts.
  const rest = Math.max(0, engine - rows.reduce((sum, row) => sum + row.usd + row.other, 0))

  return { path, rows, offset, mark, marks, rest }
}
