import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { cursor, feed, settle } from '../hooks/tally'
import type { Row, Usage } from '../types'

const PATH = '/home/me/.claude/projects/-work/s1.jsonl'
const AGENT = '/home/me/.claude/projects/-work/s1/subagents/agent-a1.jsonl'

// Counts transcripts' texts whole, the main one first.
const count = (main: string, agents: string[] = []): Row[] => {
  const rows: Row[] = []
  feed(cursor(), rows, main, true)

  for (const agent of agents) {
    feed(cursor(), rows, agent, false)
  }

  return rows
}

// The engine's file ops over `files`, a transcript's text by path as the CLI leaves it, its subagents'
// folder beside it. `tail -c +N` serves a file from byte N in `cut`-byte pieces (the engine's 4 MiB), or
// cannot start while `isGone`; the calls made are returned.
const serve = (
  on: On,
  files: () => Record<string, string>,
  { cut = Infinity, isGone = () => false }: { cut?: number; isGone?: () => boolean } = {},
): string[][] => {
  const runs: string[][] = []
  const bytes = (path: string) => new TextEncoder().encode(files()[path] ?? '')
  const under = (folder: string) => Object.keys(files()).filter(path => path.startsWith(`${folder}/`))

  on('fs.exists', (_, e) => ({ value: e.path in files() || under(e.path).length > 0 }))
  on('fs.stat', (_, e) =>
    e.path in files()
      ? { value: { kind: 'file', size: bytes(e.path).length, mtimeMs: 0, isLink: false } }
      : { deny: 'ENOENT' },
  )
  on('fs.list', (_, e) => ({
    value: under(e.path).map(path => ({
      name: path.slice(e.path.length + 1),
      kind: 'file',
      size: bytes(path).length,
      mtimeMs: 0,
      isLink: false,
    })),
  }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])

    if (isGone()) {
      return { deny: 'tail: cannot start' }
    }

    // `sh -c 'tail -c +N "$2" | head -c 1' sh N path`: the byte before where a saved count stopped.
    if (e.argv[0] === 'sh') {
      const [, , , , at = '0', file = ''] = e.argv
      const byte = bytes(file).slice(Number(at) - 1, Number(at))

      return {
        value: {
          exitCode: 0,
          stdout: new TextDecoder().decode(byte),
          stderr: '',
          isStdoutTruncated: false,
          isStderrTruncated: false,
        },
      }
    }

    const [, , from = '+1', path = ''] = e.argv
    const piece = bytes(path).slice(Number(from.slice(1)) - 1)

    return {
      value: {
        exitCode: 0,
        stdout: new TextDecoder().decode(piece.slice(0, cut)),
        stderr: '',
        isStdoutTruncated: piece.length > cut,
        isStderrTruncated: false,
      },
    }
  })

  return runs
}

const prompt = (promptId: string, uuid: string) =>
  JSON.stringify({ type: 'user', promptId, uuid, message: { role: 'user', content: 'hi' } })

const reply = (id: string, model: string, usage: object) =>
  JSON.stringify({ type: 'assistant', message: { id, model, usage } })

// A prompt's uuid, and the engine's name for its row: the last group zeroed.
const U2 = '77832199-823b-40c6-aeb7-378da5551b9f'
const U2_ROW = '77832199-823b-40c6-aeb7-000000000000'

const FIRST = {
  input_tokens: 1000,
  output_tokens: 2000,
  cache_read_input_tokens: 1_000_000,
  cache_creation_input_tokens: 3000,
  cache_creation: { ephemeral_1h_input_tokens: 1000 },
}

const MAIN = [
  prompt('p1', 'u1'),
  // One response stored twice (a row per content block): counted once.
  reply('m1', 'claude-fable-5-1', FIRST),
  reply('m1', 'claude-fable-5-1', FIRST),
  // A tool result carries its prompt's id: no new row.
  prompt('p1', 'u1-tool'),
  // A slash command's caveat is a meta entry the transcript never draws: the row takes the command's uuid.
  JSON.stringify({ type: 'user', promptId: 'p2', uuid: 'u2-meta', isMeta: true, message: {} }),
  prompt('p2', U2),
  // The advisor's request inside a response is priced at its own model.
  reply('m2', 'claude-haiku-4-5-20251001', {
    input_tokens: 0,
    output_tokens: 0,
    iterations: [
      { type: 'message', input_tokens: 100, output_tokens: 100 },
      { type: 'advisor_message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 1000 },
    ],
  }),
  // A client-local command (/reload-plugins) between turns writes a user entry but runs no model turn: no row.
  JSON.stringify({
    type: 'user',
    promptId: 'p-local',
    uuid: 'u-local',
    message: { role: 'user', content: '<command-name>/reload-plugins</command-name>' },
  }),
  // A line still being written is skipped.
  '{"type":"assistant","message":{"id":"m3","mod',
].join('\n')

const SUB = `${[
  JSON.stringify({ type: 'user', promptId: 'p1', uuid: 'a-u1', isSidechain: true, message: {} }),
  reply('s1', 'claude-haiku-4-5-20251001', { input_tokens: 2000, output_tokens: 1000 }),
  reply('s2', 'some-new-model', { input_tokens: 5, output_tokens: 5 }),
].join('\n')}\n`

test('tally prices each prompt from the transcript and its subagents', () => {
  const [first, second, ...rest] = count(MAIN, [SUB])

  expect(rest).toEqual([])
  // 1000*10 + 2000*12.5 + 1000*20 + 1M*0.25 + 2000*50 per 1e6, plus the subagent's 2000*1 + 1000*5.
  expect(first).toMatchObject({
    id: 'p1',
    uuid: 'u1',
    model: 'fable-5-1',
    input: 3005,
    output: 3005,
    cacheRead: 1_000_000,
    cacheWrite: 3000,
    isUnpriced: true,
  })
  expect(first?.usd.toFixed(6)).toBe('0.412000')
  // 100*1 + 100*5 at Haiku 4.5, 1000*4 + 1000*20 at Opus 5.5.
  expect(second).toMatchObject({ id: 'p2', uuid: U2, model: 'haiku-4-5', input: 1100, output: 1100, isUnpriced: false })
  expect(second?.usd.toFixed(6)).toBe('0.024600')
})

test('a client-local command leaves no row', () => {
  const local = JSON.stringify({
    type: 'user',
    promptId: 'p-local',
    uuid: 'u-local',
    message: { role: 'user', content: '<command-name>/reload-plugins</command-name>' },
  })

  // On its own it lists nothing; after a real turn only the real prompt remains.
  expect(count(`${local}\n`)).toEqual([])
  expect(
    count(`${[prompt('p1', 'u1'), reply('m1', 'claude-opus-5-5', FIRST), local].join('\n')}\n`).map(row => row.id),
  ).toEqual(['p1'])
})

test('a cursor feeds whole lines, waits for one without its newline, and counts a response by its latest copy', () => {
  const rows: Row[] = []
  const place = cursor()
  const hello = `${JSON.stringify({ type: 'user', promptId: 'p1', uuid: 'u1', message: { role: 'user', content: '안녕' } })}\n`
  const answer = `${reply('m1', 'claude-opus-5-5', { input_tokens: 10 })}\n`
  // A subagent's first copy lacks the output its last copy has.
  const full = `${reply('m1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 5 })}\n`

  // The prompt's line is fed, counted in bytes; the response's, cut short, waits.
  expect(feed(place, rows, `${hello}${answer.slice(0, 20)}`, true)).toBe(hello.length + 4)
  expect(rows.map(row => row.input)).toEqual([0])
  // Whole, it counts; a copy with more counts in its place; fed again (a count overlapping another), nothing changes.
  expect(feed(place, rows, `${answer}${full}`, true)).toBe(answer.length + full.length)
  expect(feed(place, rows, full, true)).toBe(full.length)
  expect(rows.map(row => [row.input, row.output, row.usd])).toEqual([[10, 5, 0.00014]])
})

test('settle sets what the engine billed beyond the transcripts against the prompt it fell in', () => {
  const row = (id: string, usd: number): Row => ({
    id,
    uuid: id,
    model: '',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    usd,
    other: 0,
    isUnpriced: false,
  })
  const others = (state: Usage) => state.rows.map(one => one.other.toFixed(2))
  let state: Usage = { path: null, rows: [], offset: null, mark: 0, marks: {}, rest: 0 }

  // First seen mid-session: the 4.00 billed before is nobody's.
  state = settle(state, 'p', [row('p1', 1)], 5, false)
  expect(others(state)).toEqual(['0.00'])
  expect(state.rest.toFixed(2)).toBe('4.00')
  // 0.50 more billed, 0.20 of it in the transcript: 0.30 of internal calls.
  state = settle(state, 'p', [row('p1', 1.2)], 5.5, false)
  expect(others(state)).toEqual(['0.30'])
  // What is billed up to the next prompt's submission still belongs to the first.
  state = settle(state, 'p', [row('p1', 1.2)], 5.6, true)
  state = settle(state, 'p', [row('p1', 1.2), row('p2', 2)], 7.9, false)
  expect(others(state)).toEqual(['0.40', '0.30'])
  // The rows and the rest come to the engine's total, what /cost shows.
  expect((1.2 + 0.4 + 2 + 0.3 + state.rest).toFixed(2)).toBe('7.90')
  // With no cost ledger nothing is added.
  expect(others(settle(state, 'p', [row('p1', 1.2)], undefined, false))).toEqual(['0.00'])
})

test('the pane lists every prompt; pressing a row reveals its prompt and beats its border for 3s', async ($, on) => {
  const toasts: string[] = []
  const clock = mock.clock(on)
  // The engine's total: 0.50 billed before the mod first counted.
  let billed = 0.412 + 0.0246 + 0.5

  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: billed } },
  }))

  serve(on, () => ({ [PATH]: MAIN, [AGENT]: SUB }))
  on('classic.PostToolUse', () => ({}))
  // The kit has no transcript to scroll: the mod says so and beats all the same.
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return h(Text, null, 'engine') as never
  })

  // Two counts at once (a tool's end, the engine's bill) feed the same lines: counted once.
  await Promise.all([
    $.classic.PostToolUse({ transcript_path: PATH } as never),
    $.classic.PostToolUse({ transcript_path: PATH } as never),
  ])

  // Above the prompt the columns spread over the width: 12 spare cells, 2 per gap.
  const wide = await $.ui.mount({
    plugin: 'token-panel',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'token-panel',
    props: { title: 'Token panel', isFocused: false, bodyColumns: 61, placement: 'inline' } as never,
  })

  expect((await wide.find({ key: `row:${U2}` }))?.props.label).toBe(
    '  2   haiku-4-5     1.1k     1.1k        0        0     $0.02',
  )
  expect((await wide.find({ type: 'Box' }))?.props.paddingY).toBe(0)
  await wide.unmount()

  const pane = await $.ui.mount({
    plugin: 'token-panel',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'token-panel',
    props: { title: 'Token panel', isFocused: false, bodyColumns: 40, placement: 'dock' } as never,
  })

  // Docked, two empty rows above and below the table.
  expect((await pane.find({ type: 'Box' }))?.props.paddingY).toBe(2)
  expect((await pane.find({ key: 'row:u1' }))?.props.label).toBe('  1 fable-5-1   3.0k   3.0k  1.00M   3.0k   ?0.41')
  expect((await pane.find({ key: `row:${U2}` }))?.props.label).toBe('  2 haiku-4-5   1.1k   1.1k      0      0   $0.02')

  // An internal call billed 1.00 with no transcript row: the running prompt's.
  billed += 1
  await $.classic.PostToolUse({ transcript_path: PATH } as never)
  expect((await pane.find({ key: `row:${U2}` }))?.props.label).toBe('  2 haiku-4-5   1.1k   1.1k      0      0   $1.02')

  expect(await pane.find({ type: 'Text', text: /^etc unplaced .*\$0\.50$/ })).toBeDefined()
  // The first prompt used a model the rate table lacks, so the sum is marked `?`.
  expect(await pane.find({ type: 'Text', text: new RegExp(`^sum .*[?]${billed.toFixed(2)}$`) })).toBeDefined()

  const row = await $.ui.mount({
    plugin: 'token-panel',
    surface: 'terminal',
    component: 'UserMessage',
    requestId: U2_ROW,
    props: { text: 'second', origin: { kind: 'human' }, isExpanded: false } as never,
  })

  expect(await row.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await pane.press({ key: `row:${U2}` })
  expect(toasts).toEqual([expect.stringContaining('ui.scroll')])
  expect((await row.find({ type: 'Box' }))?.props).toMatchObject({ borderColor: 'red', borderDimColor: false })
  await clock.advance(500)
  expect((await row.find({ type: 'Box' }))?.props).toMatchObject({ borderDimColor: true })
  await clock.advance(2000)
  expect(await row.find({ type: 'Box' })).toBeDefined()
  await clock.advance(500)
  expect(await row.find({ type: 'Box' })).toBeUndefined()
  expect(await row.find({ type: 'Text', text: 'engine' })).toBeDefined()
})

test('above the prompt the list shows the five newest prompts and scrolls under the head and the sum', async ($, on) => {
  const many = `${['1', '2', '3', '4', '5', '6', '7'].map(n => prompt(`p${n}`, `u${n}`)).join('\n')}\n`

  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  serve(on, () => ({ [PATH]: many }))
  on('classic.PostToolUse', () => ({}))
  await $.classic.PostToolUse({ transcript_path: PATH } as never)

  const pane = await $.ui.mount({
    plugin: 'token-panel',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'token-panel',
    props: { title: 'Token panel', isFocused: false, bodyColumns: 49, placement: 'inline' } as never,
  })
  const listed = async () => {
    const shown: string[] = []

    for (const n of ['1', '2', '3', '4', '5', '6', '7']) {
      if (await pane.find({ key: `row:u${n}` })) {
        shown.push(n)
      }
    }

    return shown
  }
  // The person's wheel over the pane: `by` rows, negative toward the top.
  const wheel = (by: number) =>
    $.ui.scroll({
      component: 'Pane',
      requestId: 'token-panel',
      offset: 0,
      by,
      bodyRows: 9,
      contentRows: 9,
      origin: { kind: 'person' },
    } as never)

  expect(await listed()).toEqual(['3', '4', '5', '6', '7'])
  // A row keeps its number in the session, not its place in the window.
  expect((await pane.find({ key: 'row:u3' }))?.props.label).toMatch(/^ {2}3 /)
  await wheel(-1)
  expect(await listed()).toEqual(['2', '3', '4', '5', '6'])
  expect((await pane.find({ key: 'row:u2' }))?.props.label).toMatch(/^ {2}2 /)
  // Past the oldest it stops.
  await wheel(-5)
  expect(await listed()).toEqual(['1', '2', '3', '4', '5'])
  await wheel(9)
  expect(await listed()).toEqual(['3', '4', '5', '6', '7'])
  expect(await pane.find({ type: 'Text', text: /^sum / })).toBeDefined()
})

test('a prompt submitted before its transcript is written is listed when the turn ends', async ($, on) => {
  let isWritten = false

  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  serve(on, () => (isWritten ? { [PATH]: `${prompt('p1', 'u1')}\n` } : {}))
  on('classic.UserPromptSubmit', () => ({}))
  on('turn.complete', () => ({ text: '' }))

  await $.classic.UserPromptSubmit({ transcript_path: PATH } as never)

  const pane = await $.ui.mount({
    plugin: 'token-panel',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'token-panel',
    props: { title: 'Token panel', isFocused: false, bodyColumns: 49, placement: 'inline' } as never,
  })

  expect(await pane.find({ type: 'Text', text: 'No prompts yet.' })).toBeDefined()

  isWritten = true
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't1' } as never)
  expect(await pane.find({ key: 'row:u1' })).toBeDefined()
})

test('a transcript is read through tail in pieces, each count from where the last ended; a failed count says why', async ($, on) => {
  let isGone = false
  // The engine cuts a run's output at 4 MiB; here at 150 bytes, inside a line.
  const runs = serve(on, () => ({ [PATH]: MAIN }), { cut: 150, isGone: () => isGone })

  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('classic.PostToolUse', () => ({}))
  await $.classic.PostToolUse({ transcript_path: PATH } as never)

  const pane = await $.ui.mount({
    plugin: 'token-panel',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'token-panel',
    props: { title: 'Token panel', isFocused: false, bodyColumns: 40, placement: 'dock' } as never,
  })

  expect(runs[0]).toEqual(['tail', '-c', '+1', PATH])
  expect(runs.length).toBeGreaterThan(2)
  expect((await pane.find({ key: 'row:u1' }))?.props.label).toBe('  1 fable-5-1   1.0k   2.0k  1.00M   3.0k   $0.41')
  expect((await pane.find({ key: `row:${U2}` }))?.props.label).toBe('  2 haiku-4-5   1.1k   1.1k      0      0   $0.02')
  expect(await pane.find({ type: 'Text', text: /^Token panel: / })).toBeUndefined()

  // The next count reads from the first byte of the line still being written, and nothing before it.
  const whole = new TextEncoder().encode(MAIN.slice(0, MAIN.lastIndexOf('\n') + 1)).length
  const before = runs.length
  await $.classic.PostToolUse({ transcript_path: PATH } as never)
  expect(runs.slice(before)).toEqual([['tail', '-c', `+${whole + 1}`, PATH]])

  // No tail on the host: the table stays and the pane says why; the next count that succeeds clears it.
  isGone = true
  await $.classic.PostToolUse({ transcript_path: PATH } as never)
  expect(await pane.find({ key: `row:${U2}` })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^Token panel: .*tail/ })).toBeDefined()
  isGone = false
  await $.classic.PostToolUse({ transcript_path: PATH } as never)
  expect(await pane.find({ type: 'Text', text: /^Token panel: / })).toBeUndefined()
})

test('/token-panel closes an open pane and opens a closed one', async ($, on) => {
  const calls: string[] = []
  let isPlaced = true

  on('ui.panes', () => ({
    value: [{ id: 'token-panel', title: 'Token panel', isShown: true, isFocused: false, isPlaced }],
  }))
  on('ui.close', () => (calls.push('close'), { value: undefined }))
  on('ui.open', () => (calls.push('open'), { value: { isPlaced: true } }))

  const run = () => $.command.run({ command: 'token-panel', args: '' } as never)

  expect((await run()).text).toBe('Token panel off.')
  isPlaced = false
  expect((await run()).text).toBe('Token panel on.')
  expect(calls).toEqual(['close', 'open'])
})

test('the band above the prompt holds a button while the pane is shut; it opens the pane, closing brings it back', async ($, on) => {
  on('ui.panes', () => ({
    value: [{ id: 'token-panel', title: 'Token panel', isShown: true, isFocused: false, isPlaced: true }],
  }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return h(Text, null, 'engine') as never
  })

  const band = await $.ui.mount({
    plugin: 'token-panel',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 80 } as never,
  })

  expect((await band.find({ key: 'open' }))?.props.label).toBe('TokenPanel')
  await band.press({ key: 'open' })
  expect(await band.find({ key: 'open' })).toBeUndefined()
  await $.command.run({ command: 'token-panel', args: '' } as never)
  expect(await band.find({ key: 'open' })).toBeDefined()
})

test('with no classic event, a turn finds the transcript where the CLI keeps it once it is written', async ($, on) => {
  let isWritten = false

  on('env.get', () => ({ value: '/home/me' }))
  on('session.root', () => ({ value: '/work' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  serve(on, () => (isWritten ? { [PATH]: MAIN } : {}))
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_, e) => e as never)
  on('turn.complete', () => ({ text: '' }) as never)

  const pane = await $.ui.mount({
    plugin: 'token-panel',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'token-panel',
    props: { title: 'Token panel', isFocused: false, bodyColumns: 40, placement: 'dock' } as never,
  })

  // The session starts before its transcript is written.
  await $.session.start({ cwd: '/work' } as never)
  expect(await pane.find({ type: 'Text', text: 'No prompts yet.' })).toBeDefined()

  isWritten = true
  await $.turn.complete({ answer: '' } as never)
  expect(await pane.find({ key: 'row:u1' })).toBeDefined()
})

// The plugin's store, held in `held` for the test to read.
const store = (on: On, held: Map<string, unknown>): void => {
  on('store.get', (_, e) => ({ value: held.get(e.key) }))
  on('store.set', (_, e) => (held.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }))
  on('store.delete', (_, e) => (held.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...held.keys()] }))
}

const OTHER = '/home/me/.claude/projects/-work/s2.jsonl'
// MAIN's whole lines: the line still being written left out.
const WHOLE = `${MAIN.slice(0, MAIN.lastIndexOf('\n'))}\n`

test("a turn's end saves the count; a count that takes it up again reads only what came after it", async ($, on) => {
  const held = new Map<string, unknown>([
    ['note', 'kept'],
    ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => [`count:/old${n}`, {}] as const),
  ])
  const later = `${prompt('p3', 'u3')}\n${reply('m9', 'claude-opus-5-5', { input_tokens: 7 })}\n`
  let files: Record<string, string> = { [PATH]: WHOLE, [AGENT]: SUB, [OTHER]: `${prompt('q1', 'v1')}\n` }
  const runs = serve(on, () => files)

  store(on, held)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('classic.PostToolUse', () => ({}))
  on('turn.complete', () => ({ text: '' }) as never)

  await $.classic.PostToolUse({ transcript_path: PATH } as never)
  await $.turn.complete({ answer: '' } as never)

  // Saved last; the oldest count made room, and what else the store held stays.
  expect([...held.keys()]).toEqual(['note', ...[2, 3, 4, 5, 6, 7, 8].map(n => `count:/old${n}`), `count:${PATH}`])

  // Another transcript's count (/clear), then this one's again: taken up from where it was saved.
  await $.classic.PostToolUse({ transcript_path: OTHER } as never)
  files = { ...files, [PATH]: WHOLE + later }
  const before = runs.length
  await $.classic.PostToolUse({ transcript_path: PATH } as never)

  const at = new TextEncoder().encode(WHOLE).length
  expect(runs.slice(before)).toContainEqual(['tail', '-c', `+${at + 1}`, PATH])
  expect(runs.slice(before)).not.toContainEqual(['tail', '-c', '+1', PATH])

  const pane = await $.ui.mount({
    plugin: 'token-panel',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'token-panel',
    props: { title: 'Token panel', isFocused: false, bodyColumns: 40, placement: 'dock' } as never,
  })

  // The rows a count from the first byte gives.
  const rows = count(WHOLE + later, [SUB])
  expect(rows.map(row => row.uuid)).toEqual(['u1', U2, 'u3'])

  for (const row of rows) {
    expect((await pane.find({ key: `row:${row.uuid}` }))?.props.label).toContain(row.usd.toFixed(2))
  }

  expect(await pane.find({ key: 'row:v1' })).toBeUndefined()
})

test('a saved count made by other rules, or whose file no longer ends a line where it stopped, counts from the first byte', async ($, on) => {
  const held = new Map<string, unknown>()
  let files: Record<string, string> = { [PATH]: WHOLE, [OTHER]: '' }
  const runs = serve(on, () => files)

  store(on, held)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('classic.PostToolUse', () => ({}))
  on('turn.complete', () => ({ text: '' }) as never)

  await $.classic.PostToolUse({ transcript_path: PATH } as never)
  await $.turn.complete({ answer: '' } as never)
  const saved = held.get(`count:${PATH}`) as { rules: string }

  // The rules are the counting code's own text, so an edit to it is told apart.
  expect(saved.rules).toContain('promptId')

  // Rewritten in place: a byte more ahead of where the count stopped.
  files = { ...files, [PATH]: ` ${WHOLE}` }
  await $.classic.PostToolUse({ transcript_path: OTHER } as never)
  let before = runs.length
  await $.classic.PostToolUse({ transcript_path: PATH } as never)
  expect(runs.slice(before)).toContainEqual(['tail', '-c', '+1', PATH])

  // Saved by another release's rules.
  files = { ...files, [PATH]: WHOLE }
  held.set(`count:${PATH}`, { ...saved, rules: 'other' })
  await $.classic.PostToolUse({ transcript_path: OTHER } as never)
  before = runs.length
  await $.classic.PostToolUse({ transcript_path: PATH } as never)
  expect(runs.slice(before)).toEqual([['tail', '-c', '+1', PATH]])
})
