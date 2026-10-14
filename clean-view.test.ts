import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { METER_CELLS, barCells, cleanName, errorSentence, fmtDuration, meterCells } from './hooks/clean-view'

const PLAN = 'mcp__clean-view__plan_steps'
const REPORT = 'mcp__clean-view__report_progress'

const BAND = {
  plugin: 'clean-view',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const SURFACES = ['terminal', 'desktop'] as const

// What the engine does beneath the plugin, plus a memory clock and store.
function world(on: On, answer: string | ((model: string) => unknown) = 'Build my landing page') {
  const clock = mock.clock(on)
  mock.store(on)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const toasts: string[] = []
  on('ui.toast', (_$, e) => (toasts.push(JSON.stringify(e)), { value: {} }) as never)
  on('classic.Notification', () => ({}) as never)
  on('classic.PermissionDenied', () => ({}) as never)
  on('classic.StopFailure', () => ({}) as never)
  on('model.complete', (_$, e) => ({ value: typeof answer === 'function' ? answer(e.model) : { isAnswered: true, text: answer, usage: {} } }) as never)
  return { clock, toasts }
}

// The band as a person sees it: the title plus every Text, in order.
async function shown($: Engine, surface: 'terminal' | 'desktop' = 'terminal'): Promise<string> {
  const ui = await $.ui.mount({ ...BAND, surface })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t.length > 1 && !/^▆+$/.test(t))
  const title = (await ui.find({ key: 'title' }))?.text ?? ''
  await ui.unmount()
  return [title, ...texts].join(' | ')
}

const finish = ($: Engine, extra: object = {}) =>
  $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...extra } as never)

test('cleanName strips code, paths and file names, trims to 40', () => {
  expect(cleanName('Build the pricing section in `src/Pricing.tsx`')).toBe('Build the pricing section in')
  expect(cleanName('Fix the file src/components/Card.tsx quickly')).toBe('Fix the file quickly')
  expect(cleanName('open App.tsx and then Main.py')).toBe('Open and then')
  expect(cleanName('   many    spaces   here ')).toBe('Many spaces here')
  expect(cleanName('`x` /a/b')).toBe('Working on it')
  const long = cleanName('word '.repeat(16).trim())
  expect(long.length).toBeLessThanOrEqual(40)
  expect(long.endsWith('…')).toBe(true)
})

test('errorSentence and fmtDuration map plainly', () => {
  expect(errorSentence('rate_limit')).toBe('you hit your usage limit, try again a little later')
  expect(errorSentence('overloaded')).toBe("Claude's servers are busy, try again in a minute")
  expect(errorSentence('invalid_request', 'prompt is too long')).toBe('type /compact and try again')
  expect(errorSentence('authentication_failed')).toBe('type /login')
  expect(errorSentence('unknown', 'fetch failed ECONNRESET')).toBe('the internet connection dropped')
  expect(fmtDuration(8000)).toBe('8s')
  expect(fmtDuration(72000)).toBe('1m 12s')
})

test('plan_steps then report_progress 100 checks off step one and starts step two', async ($, on) => {
  world(on)
  const planned = await $.tool.call({ tool: PLAN, steps: ['Read your brand notes', 'Build the pricing section', 'Add the contact form'] })
  expect(JSON.stringify(planned)).toContain('Planned 3 steps. The first one has started.')
  expect(await shown($)).toContain('Build the pricing section | Next')
  const reported = await $.tool.call({ tool: REPORT, task: 'Read your brand notes', percent: 100 })
  expect(JSON.stringify(reported)).toContain('Progress noted: 100%.')
  const text = await shown($)
  expect(text).toMatch(/Read your brand notes \| Done/)
  expect(text).toContain('Build the pricing section | Working')
  expect(text).toContain('Add the contact form | Next')
})

test('report_progress clamps, checks off earlier steps and adds unknown names', async ($, on) => {
  world(on)
  await $.tool.call({ tool: PLAN, steps: ['One thing', 'Two things', 'Three things'] })
  await $.tool.call({ tool: REPORT, task: 'Three things', percent: 250 })
  expect((await shown($)).match(/Done/g)?.length).toBe(3)
  await $.tool.call({ tool: REPORT, task: 'A brand new step', percent: 30 })
  expect(await shown($)).toContain('A brand new step | 30%')
})

test('any tool is denied before a plan exists and allowed after; subagents never gated', async ($, on) => {
  world(on)
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: { filePath: 'x', content: '', numLines: 0, startLine: 1, totalLines: 0 } } }) as never)
  const before = await $.tool.call({ tool: 'Read', file_path: 'x.txt' })
  expect(before.deny).toContain('plan_steps')
  const sub = await $.tool.call({ tool: 'Read', file_path: 'x.txt', agentId: 'sub-1' } as never)
  expect(sub.deny).toBeUndefined()
  await $.tool.call({ tool: PLAN, steps: ['Look around', 'Report back'] })
  const after = await $.tool.call({ tool: 'Read', file_path: 'x.txt' })
  expect(after.deny).toBeUndefined()
})

test('a to-do list plus a 60% report renders done / 60% / Next / Up next', async ($, on) => {
  world(on)
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }) as never)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read your brand notes', status: 'completed', activeForm: 'Reading' },
      { content: 'Build the pricing section', status: 'in_progress', activeForm: 'Building' },
      { content: 'Add the contact form', status: 'pending', activeForm: 'Adding' },
      { content: 'Polish the footer', status: 'pending', activeForm: 'Polishing' },
    ],
  })
  await $.tool.call({ tool: REPORT, task: 'Build the pricing section', percent: 60 })
  for (const surface of SURFACES) {
    const text = await shown($, surface)
    expect(text).toContain('Read your brand notes | Done')
    expect(text).toContain('Build the pricing section | 60%')
    expect(text).toContain('Add the contact form | Next')
    expect(text).toContain('Polish the footer | Up next')
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'toggle' })).toBeDefined()
    await ui.unmount()
  }
})

test('a permission prompt shows Needs you', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'build my page', turnId: 't1' })
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  for (const surface of SURFACES) {
    const text = await shown($, surface)
    expect(text).toContain('Needs you')
    expect(text).toContain('Claude needs your OK to continue')
  }
})

test('turn.start names the job in the background and starts with placeholders', async ($, on) => {
  const { clock } = world(on, 'Build my landing page.')
  await $.turn.start({ text: 'build my page', turnId: 't1' })
  await clock.settle()
  const text = await shown($)
  expect(text).toContain('Build my landing page')
  expect(text).not.toContain('Build my landing page.')
  expect(text).toContain('Understand your request | Working')
  expect(text).toContain('Plan the steps | Next')
})

test('/simple off hides the band and brings tool rows back; /simple restores it', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'build my page', turnId: 't1' })
  const toolUse = { tool_use_id: 'u1', tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false } as const
  const hidden = await $.ui.mount({ plugin: 'clean-view', surface: 'terminal', component: 'ToolUse', props: toolUse })
  expect(await hidden.drawn()).toMatchObject({ props: { display: 'none' } })
  await hidden.unmount()
  await $.command.run({ command: 'simple', args: 'off', origin: { kind: 'composer' } } as never)
  for (const surface of SURFACES) {
    const text = await shown($, surface)
    expect(text).not.toMatch(/Step \d+ of/)
    expect(text).not.toContain('Understand your request')
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'toggle' })).toBeDefined()
    await ui.unmount()
  }
  await $.command.run({ command: 'simple', args: '', origin: { kind: 'composer' } } as never)
  expect(await shown($)).toContain('Understand your request')
})

test('the button flips Clean View and shows a toast', async ($, on) => {
  const { toasts } = world(on)
  await $.turn.start({ text: 'build my page', turnId: 't1' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await $.ui.press({ plugin: 'clean-view', key: 'toggle' })
  expect(await shown($)).not.toContain('Understand your request')
  await $.ui.press({ plugin: 'clean-view', key: 'toggle' })
  expect(await shown($)).toContain('Understand your request')
  await ui.unmount()
  expect(toasts.join(' ')).toMatch(/Clean View off/)
})

test('turn.complete: unfinished waits; done stays fully shown; esc stops; refusal and error are calm', async ($, on) => {
  const { clock } = world(on)
  await $.turn.start({ text: 'a', turnId: 't1' })
  await $.tool.call({ tool: PLAN, steps: ['First thing', 'Second thing'] })
  await finish($)
  expect(await shown($)).toContain('Claude is waiting for your reply')

  await $.tool.call({ tool: REPORT, task: 'Second thing', percent: 100 })
  await finish($)
  let text = await shown($)
  expect(text).toContain('All done')
  expect(text).toMatch(/2 of 2 steps/)
  await clock.advance(60000)
  text = await shown($)
  expect(text).toContain('All done')
  expect(text).toMatch(/2 of 2 steps/)
  expect(text).toContain('First thing | Done')
  expect(text).toContain('Second thing | Done')

  await $.turn.start({ text: 'b', turnId: 't2' })
  await finish($, { reason: 'aborted', isAborted: true })
  expect(await shown($)).toContain('■ Stopped')

  await $.turn.start({ text: 'c', turnId: 't3' })
  await finish($, { reason: 'refusal', refusal: { category: null, explanation: null } })
  expect(await shown($)).toContain("Stuck: Claude couldn't help with that request")

  await $.turn.start({ text: 'd', turnId: 't4' })
  await $.classic.StopFailure({ error: 'rate_limit' } as never)
  await finish($, { reason: 'error' })
  expect(await shown($)).toContain('Stuck: you hit your usage limit, try again a little later')
})

test('three failed tool calls in a row show Stuck and a success clears it', async ($, on) => {
  world(on)
  let fail = true
  on('tool.call', { tool: 'Bash' }, () => (fail ? { result: {}, text: 'boom', isError: true } : { result: {}, text: 'ok' }) as never)
  await $.turn.start({ text: 'a', turnId: 't1' })
  await $.tool.call({ tool: PLAN, steps: ['First thing', 'Second thing'] })
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'false' })
  expect(await shown($)).toContain('Stuck: a step keeps failing, Claude is trying another way')
  fail = false
  await $.tool.call({ tool: 'Bash', command: 'true' })
  expect(await shown($)).not.toContain('Stuck')
})

test('a user no on a permission shows Stuck', async ($, on) => {
  world(on)
  await $.turn.start({ text: 'a', turnId: 't1' })
  await $.tool.call({ tool: PLAN, steps: ['First thing', 'Second thing'] })
  await $.classic.PermissionDenied({ tool_name: 'Bash', tool_input: {}, tool_use_id: 'u1', reason: 'user declined' } as never)
  expect(await shown($)).toContain('Stuck: you said no to a step, so Claude paused')
})

const lower = (cells: string[]) => cells.map(c => c.toLowerCase())

test('meters are 16 cells wide', () => {
  expect(METER_CELLS).toBe(16)
  for (const kind of ['done', 'percent', 'sweep', 'empty'] as const) expect(meterCells(kind, 40, 3)).toHaveLength(16)
})

test('main bar track is #0F0F0F and the fill runs orange to pink', () => {
  const cells = lower(barCells(40, 20, false, 2))
  expect(cells).toHaveLength(20)
  expect(cells.slice(8).every(c => c === '#0f0f0f')).toBe(true)
  expect(cells[0]).toBe('#ff8c42')
  expect(cells[7]).toBe('#ff5f87')
  expect(lower(barCells(0, 20, false, 0)).every(c => c === '#0f0f0f')).toBe(true)
})

test('a finished bar is green, dark to light', () => {
  const cells = lower(barCells(100, 20, true, 0))
  expect(cells[0]).toBe('#1f7a35')
  expect(cells[19]).toBe('#5fd47a')
})

test('a percent meter fills its share, orange at the start and pink at the filled end', () => {
  const cells = lower(meterCells('percent', 40, 0))
  expect(cells[0]).toBe('#ff8c42')
  expect(cells[5]).toBe('#ff5f87')
  expect(cells.slice(6).every(c => c === '#0f0f0f')).toBe(true)
})

test('done meter runs dark green to light green', () => {
  const cells = lower(meterCells('done', 100, 0))
  expect(cells[0]).toBe('#1f7a35')
  expect(cells[15]).toBe('#5fd47a')
})

test('the working sweep is a comet whose hue follows its head from orange to blue', () => {
  const lit = (tick: number) => lower(meterCells('sweep', 0, tick)).filter(c => c !== '#0f0f0f')
  expect(lit(0)).toEqual(['#ff8c42'])
  expect(lit(3)).toHaveLength(4)
  expect(lit(15)).toHaveLength(6)
  expect(lower(meterCells('sweep', 0, 15))[15]).toBe('#5b7cff')
  const mid = lower(meterCells('sweep', 0, 8))[8]!
  expect([mid === '#ff8c42', mid === '#5b7cff']).toEqual([false, false])
  const tail = lower(meterCells('sweep', 0, 15))
  expect(tail[14]).not.toBe(tail[15])
  expect(tail[15 - 6]).toBe('#0f0f0f')
  expect(lit(16 + 6)).toEqual(['#ff8c42'])
})

test('a title the model returns with a trailing full stop loses it', async ($, on) => {
  const { clock } = world(on, model => ({ isAnswered: true, text: '"Build my landing page."', usage: {} }))
  await $.turn.start({ text: 'build my page', turnId: 't1' })
  await clock.settle()
  expect(await shown($)).not.toMatch(/Build my landing page[."]/)
})

test('if the short model name is refused the full model id is tried', async ($, on) => {
  const { clock } = world(on, model =>
    model === 'haiku' ? { isAnswered: false, reason: 'api-error', status: 404, error: 'not_found', usage: {} } : { isAnswered: true, text: 'Build my landing page', usage: {} },
  )
  await $.turn.start({ text: 'build my page', turnId: 't1' })
  await clock.settle()
  expect(await shown($)).toMatch(/^Build my landing page \|/)
})

test('every meter and bar cell is a lower three-quarters block, so rows do not touch', async ($, on) => {
  world(on)
  await $.tool.call({ tool: PLAN, steps: ['First thing', 'Second thing', 'Third thing'] })
  await $.tool.call({ tool: REPORT, task: 'First thing', percent: 100 })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const cells = await ui.findAll({ type: 'Text', text: '▆' })
    const full = await ui.findAll({ type: 'Text', text: '▉' })
    // three task meters of 16 cells plus the main bar
    expect(cells.length).toBeGreaterThanOrEqual(3 * METER_CELLS + 8)
    expect(full).toHaveLength(0)
    // each task-meter cell is two columns wide: three meters of 16 cells
    expect(await ui.findAll({ type: 'Text', text: '▆▆' })).toHaveLength(3 * METER_CELLS)
    await ui.unmount()
  }
})
