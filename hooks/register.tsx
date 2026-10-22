import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Flash, Row, Usage } from '../types'
import type { Cursor } from './tally'
import { cursor, feed, settle } from './tally'

const PANE = 'token-panel'
const TITLE = 'Claude Token Panel'
// Above the prompt the table lists five prompts: the frame asks for them, the title, the head, `etc` and `sum`.
const LIST = 5
// Column widths in cells: 3, 10 for the model, 7 per token count, 8 for the cost.
const WIDTH = 49
const OPEN = { id: PANE, title: TITLE, columns: WIDTH, rows: LIST + 4 }
const HEAD = ['  #', ' model    ', '     in', '    out', ' cacheR', ' cacheW', '    cost']
const COUNTS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
const NONE: Usage = { path: null, rows: [], offset: null, mark: 0, marks: {}, rest: 0 }
const DARK: Flash = null
const usage = atom({ plugin: 'token-panel', key: 'usage' } as const, NONE)
const flash = atom({ plugin: 'token-panel', key: 'flash' } as const, DARK)
const fault = atom({ plugin: 'token-panel', key: 'fault' } as const, null as string | null)
// How many prompts the list is scrolled up from the newest: 0 keeps the newest in view.
const back = atom({ plugin: 'token-panel', key: 'back' } as const, 0)
// Whether the pane is drawn: while it is not, the band above the prompt holds its button.
const isShown = atom({ plugin: 'token-panel', key: 'isShown' } as const, false)

const tokens = (n: number): string =>
  n < 1000 ? String(n) : n < 1e6 ? `${(n / 1e3).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`

// A prompt's cost is its transcript's plus the internal calls the engine billed in it.
const cell = (row: Row, key: (typeof COUNTS)[number] | 'usd'): number =>
  key === 'usd' ? row.usd + row.other : row[key]

const line = (
  label: string,
  model: string,
  of: (key: (typeof COUNTS)[number] | 'usd') => number,
  isUnpriced: boolean,
): string[] => [
  label.padStart(3),
  ` ${model.padEnd(9)}`,
  ...COUNTS.map(key => tokens(of(key)).padStart(7)),
  `${isUnpriced ? '?' : '$'}${of('usd').toFixed(2)}`.padStart(8),
]

// Where the CLI keeps the transcript, once it is written: for when no classic
// event named it (another plugin may bypass this one's classic hooks).
const locate = async ($: EngineInterface): Promise<string | null> => {
  const path = `${await $.env.get('HOME')}/.claude/projects/${(await $.session.root()).replace(/[^a-zA-Z0-9]/g, '-')}/${await $.session.id()}.jsonl`

  return (await $.fs.exists(path)) ? path : null
}

// The session's count so far: the transcript's path, its rows, and how far each file is read. A reload
// starts over, as the module does; so does a new path (/clear).
// ponytail: a count from zero reads the whole transcript again, 18 MB in five `tail` runs and ~50 ms of parsing
type Count = { path: string; rows: Row[]; cursors: Map<string, Cursor> }
let count: Count | undefined

// Feeds `of.rows` what `path` holds past its cursor, in pieces of what a run's output carries (4 MiB): the
// engine's own read rejects a file over that, `tail` reads from any offset. Two counts at once feed the
// same lines, which count once, and set the cursor to the same place.
const pull = async ($: EngineInterface, of: Count, path: string, size: number, isMain: boolean): Promise<void> => {
  const place = of.cursors.get(path) ?? cursor()
  of.cursors.set(path, place)

  // Nothing written since the last count: a transcript only grows.
  if (size <= place.at) {
    return
  }

  const start = place.at
  // The bytes of whole lines fed by this count, and the text read past them: a line cut by a piece's
  // end is whole with the next piece.
  let done = 0
  let rest = ''

  for (let from = start; ; ) {
    const { exitCode, stdout, stderr, isStdoutTruncated } = await $.process.run(['tail', '-c', `+${from + 1}`, path])

    // A file gone or unreadable mid-way: no partial count.
    if (exitCode !== 0) {
      throw new Error(stderr.trim())
    }

    const text = rest + stdout
    done += feed(place, of.rows, text, isMain)
    place.at = start + done
    rest = text.slice(text.lastIndexOf('\n') + 1)
    // A cut inside a multi-byte character drops it: the text's own bytes are what was read whole.
    from += new TextEncoder().encode(stdout).length

    if (!isStdoutTruncated || stdout === '') {
      return
    }
  }
}

// Counts what the session's transcript, and its subagents' beside it, hold since the last count,
// then sets what the engine billed beyond them against the prompt it fell in.
// A count that fails leaves the table as it was and says why in the pane.
const refresh = async ($: EngineInterface, seen?: string, isNewPrompt = false): Promise<void> => {
  const path = seen ?? (await read($, usage)).path ?? (await locate($))

  if (path === null) {
    return
  }

  try {
    const of = count?.path === path ? count : { path, rows: [], cursors: new Map<string, Cursor>() }
    count = of

    // Before the first prompt the transcript is not written yet: count it empty, but keep its path for the next
    // count. The main transcript goes first: a subagent's prompt entries find their rows in it.
    if (await $.fs.exists(path)) {
      await pull($, of, path, (await $.fs.stat(path)).size, true)
    }

    const folder = path.replace(/\.jsonl$/, '/subagents')
    const entries = (await $.fs.exists(folder)) ? await $.fs.list(folder) : []
    await Promise.all(
      entries
        .filter(entry => entry.name.endsWith('.jsonl'))
        .map(entry => pull($, of, `${folder}/${entry.name}`, entry.size, false)),
    )

    const { cost } = await $.session.usage()
    // `settle` sets `other` on its rows: copies, so the count's rows stay the transcripts' own.
    const rows = of.rows.map(row => ({ ...row }))

    await update($, usage, old => settle(old, path, rows, cost?.usd, isNewPrompt))
    await update($, fault, () => null)
  } catch (error) {
    await update($, fault, () => `Token panel: ${String(error)}`)
  }
}

// Opens the pane; one that waits undrawn leaves the button up.
// ponytail: a waiting pane the terminal later widens to seat keeps the button beside it until pressed
const show = async ($: EngineInterface): Promise<void> => {
  const { isPlaced } = await $.ui.open(OPEN)
  await update($, isShown, () => isPlaced)
}

const shut = ($: EngineInterface): Promise<void> => update($, isShown, () => false)

// The running beat's timer: a module's own, so a reload drops it with the module.
let beat: Timer | undefined
// The prompts the list showed when last drawn: how far it can scroll.
let shown = LIST

// Brings the prompt's row into view and beats its border for three seconds.
const reveal = async ($: EngineInterface, uuid: string): Promise<void> => {
  // A row that cannot be brought into view says why; one already in view still beats.
  const { deny } = await $.ui
    .scroll({ to: { requestId: uuid }, block: 'center' })
    .catch((error: unknown) => ({ deny: String(error) }))

  if (deny !== undefined) {
    $.ui.toast(`Token panel: ${deny}`)
  }

  let beats = 0
  beat?.cancel()
  await update($, flash, () => ({ uuid, isOn: true }))
  beat = $.clock.every(500, () => {
    beats += 1

    if (beats >= 6) {
      beat?.cancel()
    }

    void update($, flash, () => (beats < 6 ? { uuid, isOn: beats % 2 === 0 } : null))
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: PANE,
      description: 'Show or hide the per-prompt token usage and cost pane',
    })
    // A reload drops the timer: no beat is left running. A past session's fault is not this one's.
    await update($, flash, () => null)
    await update($, fault, () => null)

    // Every session starts with the pane shut: the button above the prompt or /token-panel opens it.
    await refresh($)

    return next(e)
  })

  on('command.run', { command: PANE }, async $ => {
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)

    if (isOpen) {
      // The pane's own `ui.close` hook below shuts it.
      await $.ui.close({ id: PANE })

      return { text: 'Token panel off.' }
    }

    await show($)

    return { text: 'Token panel on.' }
  })

  // The pane's own close mark: the button takes its place.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await shut($)

    return closed
  })

  on('classic.SessionStart', async ($, e, next) => {
    await refresh($, e.transcript_path)

    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await refresh($, e.transcript_path, true)

    return next(e)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    await refresh($, e.transcript_path)

    return next(e)
  })

  // The engine billed something: count again, so the sum keeps up with /cost.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('cost')) {
      await refresh($)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    await refresh($)
    // The turn's last response may reach the file a moment after the turn ends.
    $.clock.after(1000, () => void refresh($))

    return ended
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const { rows, rest = 0 } = await read($, usage)
    const why = await read($, fault)
    // Docked, the table keeps two empty rows above and below it.
    const inset = e.props.placement === 'dock' ? 2 : 0
    // A failed count's line takes one of the list's.
    const room = Math.max(
      1,
      (e.props.placement === 'inline' ? LIST : (e.viewport?.rows ?? 24) - 8 - 2 * inset) - (why === null ? 0 : 1),
    )
    const end = rows.length - Math.min(await read($, back), Math.max(0, rows.length - room))
    const start = Math.max(0, end - room)
    shown = room
    // Above the prompt the table spreads over the pane's width; docked it stays compact.
    const spare = e.props.placement === 'inline' ? e.props.bodyColumns - WIDTH : 0
    const gap = ' '.repeat(Math.max(0, Math.floor(spare / (HEAD.length - 1))))

    return (
      <Box flexDirection="column" paddingY={inset}>
        <Text bold wrap="truncate-end">
          {TITLE}
        </Text>
        <Text bold wrap="truncate-end">
          {HEAD.join(gap)}
        </Text>
        {rows.length === 0 && <Text dimColor>No prompts yet.</Text>}
        {rows.slice(start, end).map((row: Row, i) => (
          <Button
            key={`row:${row.uuid}`}
            plain
            label={line(String(start + i + 1), row.model, key => cell(row, key), row.isUnpriced).join(gap)}
            onPress={() => reveal($, row.uuid)}
          />
        ))}
        {rest >= 0.005 && (
          <Text dimColor wrap="truncate-end">
            {line('etc', 'unplaced', key => (key === 'usd' ? rest : 0), false).join(gap)}
          </Text>
        )}
        <Text bold wrap="truncate-end">
          {line(
            'sum',
            '',
            key => rows.reduce((sum, row) => sum + cell(row, key), key === 'usd' ? rest : 0),
            rows.some(row => row.isUnpriced),
          ).join(gap)}
        </Text>
        {why !== null && (
          <Text color="red" wrap="truncate-start">
            {why}
          </Text>
        )}
      </Box>
    )
  })

  // The list scrolls under the title, the head and the sum, which stay put.
  on('ui.scroll', { requestId: PANE }, async ($, e) => {
    const { rows } = await read($, usage)
    await update($, back, old => Math.min(Math.max(0, rows.length - shown), Math.max(0, old - e.by)))

    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isShown))) {
      return next(e)
    }

    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box width={e.props.bodyColumns} justifyContent="flex-end">
        <Button
          key="open"
          label="TokenPanel"
          hover={{ scope: 'open', backgroundColor: 'suggestion', color: 'inverseText' }}
          onPress={() => show($)}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const lit = await read($, flash)

    // The engine names a prompt's row by its uuid with the last group zeroed: match the rest.
    if (lit === null || lit.uuid.slice(0, 23) !== e.requestId.slice(0, 23)) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box borderStyle="round" borderColor="red" borderDimColor={!lit.isOn} paddingX={1}>
        <Text bold={lit.isOn}>{e.props.text}</Text>
      </Box>
    )
  })
}
