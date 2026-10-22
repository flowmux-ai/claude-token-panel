// One prompt of the session: `id` is the transcript's promptId, `uuid` the
// prompt row's own id (what its UserMessage draws under).
export type Row = {
  id: string
  uuid: string
  // The main loop's model for the prompt, shortened for the table (`fable-5-1`).
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  usd: number
  // What the engine billed during the prompt beyond its transcript: internal
  // calls (a web search's own request, titles, summaries) no transcript row holds.
  other: number
  // True when a model no rate is known for answered: `usd` leaves its tokens out.
  isUnpriced: boolean
}

export type Usage = {
  path: string | null
  rows: Row[]
  // The engine's cost total less the transcripts', as first seen: what the
  // difference grows by afterwards is the internal calls' cost. Null until seen.
  offset: number | null
  // That growth when the latest prompt was submitted, and when each prompt began.
  mark: number
  marks: Record<string, number>
  // What the engine billed that no row holds (internal calls from before the
  // mod first counted): with it the table's sum is the engine's total, /cost's.
  rest: number
}

// The prompt row whose border beats after its pane row was pressed.
export type Flash = { uuid: string; isOn: boolean } | null

declare module 'claude-code' {
  interface PluginState {
    // `fault` says why the last count failed, while it does: the rows are the last good count's.
    'token-panel': { usage: Usage; flash: Flash; back: number; isShown: boolean; fault: string | null }
  }
}
