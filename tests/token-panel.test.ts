import { expect, mock, test } from 'claude-code/testing'

import { settle, tally } from '../hooks/tally'
import type { Row, Usage } from '../types'

const PATH = '/home/me/.claude/projects/-work/s1.jsonl'
const AGENT = '/home/me/.claude/projects/-work/s1/subagents/agent-a1.jsonl'
// A transcript the engine's own read takes: under 4 MiB.
const SMALL = { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } } as const

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

const SUB = [
  JSON.stringify({ type: 'user', promptId: 'p1', uuid: 'a-u1', isSidechain: true, message: {} }),
  reply('s1', 'claude-haiku-4-5-20251001', { input_tokens: 2000, output_tokens: 1000 }),
  reply('s2', 'some-new-model', { input_tokens: 5, output_tokens: 5 }),
].join('\n')

test('tally prices each prompt from the transcript and its subagents', () => {
  const [first, second, ...rest] = tally(MAIN, [SUB])

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
  expect(tally(local)).toEqual([])
  expect(
    tally([prompt('p1', 'u1'), reply('m1', 'claude-opus-5-5', FIRST), local].join('\n')).map(row => row.id),
  ).toEqual(['p1'])
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

  on('fs.exists', (_, e) => ({ value: e.path === PATH || e.path === PATH.replace('.jsonl', '/subagents') }))
  on('fs.stat', () => SMALL)
  on('fs.list', () => ({
    value: [{ name: 'agent-a1.jsonl', kind: 'file', size: 1, mtimeMs: 0, isLink: false }],
  }))
  on('fs.read', (_, e) => ({ value: e.path === PATH ? MAIN : e.path === AGENT ? SUB : '' }))
  on('classic.PostToolUse', () => ({}))
  // The kit has no transcript to scroll: the mod says so and beats all the same.
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return h(Text, null, 'engine') as never
  })

  await $.classic.PostToolUse({ transcript_path: PATH } as never)

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
  const many = ['1', '2', '3', '4', '5', '6', '7'].map(n => prompt(`p${n}`, `u${n}`)).join('\n')

  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('fs.exists', (_, e) => ({ value: e.path === PATH }))
  on('fs.stat', () => SMALL)
  on('fs.read', () => ({ value: many }))
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
  on('fs.exists', (_, e) => ({ value: e.path === PATH && isWritten }))
  on('fs.stat', () => SMALL)
  on('fs.read', () => ({ value: prompt('p1', 'u1') }))
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

test('a transcript past the 4 MiB read limit is read in pieces through tail; a failed count says why', async ($, on) => {
  const bytes = new TextEncoder().encode(MAIN)
  // The engine cuts a run's output at 4 MiB; here at 150 bytes, inside a line.
  const CUT = 150
  let size = 5_000_000
  const runs: string[][] = []

  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }))
  on('fs.exists', (_, e) => ({ value: e.path === PATH }))
  on('fs.stat', () => ({ value: { kind: 'file', size, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ deny: 'over 4 MiB' }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    const piece = bytes.slice(Number(e.argv[2]?.slice(1)) - 1)

    return {
      value: {
        exitCode: 0,
        stdout: new TextDecoder().decode(piece.slice(0, CUT)),
        stderr: '',
        isStdoutTruncated: piece.length > CUT,
        isStderrTruncated: false,
      },
    }
  })
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

  // A small file's read the engine refuses: the table stays and the pane says why.
  size = 10
  await $.classic.PostToolUse({ transcript_path: PATH } as never)
  expect(await pane.find({ key: `row:${U2}` })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^Token panel: .*over 4 MiB/ })).toBeDefined()

  // The next count that succeeds clears it.
  size = 5_000_000
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
  on('fs.exists', (_, e) => ({ value: isWritten && e.path === PATH }))
  on('fs.stat', () => SMALL)
  on('fs.read', () => ({ value: MAIN }))
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
