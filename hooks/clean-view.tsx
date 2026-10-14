import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CleanViewChecklist as Checklist, CleanViewPhase as Phase, CleanViewTask as Task } from '../types'

// ---------------------------------------------------------------- constants

const PLAN_TOOL = 'mcp__clean-view__plan_steps'
const REPORT_TOOL = 'mcp__clean-view__report_progress'
const ALWAYS_ALLOWED = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'AskUserQuestion', PLAN_TOOL, REPORT_TOOL])

// Short alias first (worked in a live session), full id if the alias is refused.
const TITLE_MODELS = ['haiku', 'claude-haiku-5-5']

// Lower three-quarters block: the empty top quarter keeps meters of neighbouring rows apart.
export const CELL = '▆'
// Terminal cells have a fixed width; a meter cell is this many columns wide.
const CELL_COLUMNS = 2

export const METER_CELLS = 16
const TAIL = 6
const MAX_NAME = 40
const TICK_MS = 250
const GLYPHS = ['✦', '✶', '✱', '✳', '✢']

const C = {
  orange: '#ff8c42',
  pink: '#ff5f87',
  purple: '#a98bff',
  blue: '#5b7cff',
  green: '#3fb950',
  greenDark: '#1f7a35',
  greenLight: '#5fd47a',
  amber: '#ffb454',
  dim: '#4b5263',
  track: '#0F0F0F',
  ink: '#10131a',
}

const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|json|md|py|css|scss|html?|ya?ml|sh|toml|rs|go|java|rb|php|sql|lock|txt|vue|svelte)$/i

const PROMPT = `Clean View is on. A checklist above the prompt shows the plan to a non-technical person.
- Write every step name in plain English a non-technical person understands. Keep it under 40 characters and start it with a verb, like "Build the pricing section".
- Never put file paths, file names, commands, code or tool names in a step name.
- For every request, even a quick question, call plan_steps first (${PLAN_TOOL}). Load it with ToolSearch if it is deferred. Then call report_progress (${REPORT_TOOL}) as real progress happens, and with percent 100 the moment a step finishes.
- If the session has TodoWrite or TaskCreate, you can use its to-do list as the plan instead.`

// -------------------------------------------------------------------- state

const IDLE: Checklist = {
  title: '',
  phase: 'idle',
  tasks: [],
  needsYouReason: null,
  stuckReason: null,
  startedAt: 0,
  finishedAt: null,
  isCollapsed: false,
}

const enabledAtom = atom({ plugin: 'clean-view', key: 'cleanViewEnabled' } as const, true)
const checklistAtom = atom({ plugin: 'clean-view', key: 'checklist' } as const, IDLE)
const tickAtom = atom({ plugin: 'clean-view', key: 'tick' } as const, 0)

// -------------------------------------------------------------- pure helpers

export function cleanName(raw: string): string {
  const words = raw
    .replace(/`[^`]*`/g, ' ')
    .split(/\s+/)
    .filter(w => w !== '' && !/[/\\]/.test(w) && !CODE_EXT.test(w.replace(/[.,;:!?)"']+$/, '')))
  let s = words.join(' ').trim()
  if (s === '') return 'Working on it'
  s = s[0]!.toUpperCase() + s.slice(1)
  if (s.length > MAX_NAME) {
    const cut = s.slice(0, MAX_NAME - 1)
    const space = cut.lastIndexOf(' ')
    s = (space > 0 ? cut.slice(0, space) : cut).trimEnd() + '…'
  }
  return s
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export function errorSentence(kind: string | undefined, details?: string): string {
  const d = details ?? ''
  if (kind === 'rate_limit' || kind === 'billing_error') return 'you hit your usage limit, try again a little later'
  if (kind === 'overloaded') return "Claude's servers are busy, try again in a minute"
  if (kind === 'authentication_failed' || kind === 'oauth_org_not_allowed' || kind === 'cloud_credential_error') return 'type /login'
  if (/context|too long|too large/i.test(d) && (kind === 'invalid_request' || kind === 'max_output_tokens' || kind === undefined)) return 'type /compact and try again'
  if (/network|econn|enotfound|fetch failed|timeout|socket/i.test(d)) return 'the internet connection dropped'
  return 'something went wrong, try again'
}

const task = (id: string, name: string, status: Task['status'], percent = 0, hasReported = false): Task => ({ id, name, status, percent, hasReported })

const isPlaceholder = (t: Task) => t.id.startsWith('ph-')
export const hasRealPlan = (cl: Checklist) => cl.tasks.length > 0 && !cl.tasks.some(isPlaceholder)
const hasUnfinished = (cl: Checklist) => cl.tasks.some(t => t.status !== 'done')
const isLive = (p: Phase) => p === 'working' || p === 'needs-you'

export function newJob(now: number): Checklist {
  return {
    ...IDLE,
    title: 'Working on it',
    phase: 'working',
    startedAt: now,
    tasks: [task('ph-1', 'Understand your request', 'active'), task('ph-2', 'Plan the steps', 'upcoming')],
  }
}

function activate(tasks: Task[]): Task[] {
  if (tasks.some(t => t.status === 'active')) return tasks
  const i = tasks.findIndex(t => t.status === 'upcoming')
  return i < 0 ? tasks : tasks.map((t, j) => (j === i ? { ...t, status: 'active' as const } : t))
}

export function planSteps(cl: Checklist, names: string[], now: number): Checklist {
  const clean = names.slice(0, 8).map(cleanName)
  const base = cl.phase === 'idle' || cl.phase === 'done' || cl.phase === 'stopped' ? { ...newJob(now), title: cl.title || 'Working on it' } : cl
  return {
    ...base,
    phase: 'working',
    needsYouReason: null,
    stuckReason: null,
    tasks: clean.map((n, i) => task(`s-${i + 1}`, n, i === 0 ? 'active' : 'upcoming')),
  }
}

export function reportProgress(cl: Checklist, name: string, percent: number): Checklist {
  const pct = Math.max(0, Math.min(100, Math.round(Number.isFinite(percent) ? percent : 0)))
  const clean = cleanName(name)
  let tasks = cl.tasks.slice()
  let i = tasks.findIndex(t => t.name.toLowerCase() === clean.toLowerCase())
  if (i < 0) {
    tasks = tasks.map(t => (t.status === 'active' ? { ...t, status: 'upcoming' as const } : t))
    tasks.push(task(`s-${tasks.length + 1}`, clean, 'upcoming'))
    i = tasks.length - 1
  }
  tasks = tasks.map((t, j) => {
    if (j < i) return { ...t, status: 'done' as const, percent: 100 }
    if (j === i) return pct >= 100 ? { ...t, status: 'done' as const, percent: 100, hasReported: true } : { ...t, status: 'active' as const, percent: pct, hasReported: true }
    return t.status === 'active' ? { ...t, status: 'upcoming' as const } : t
  })
  if (pct >= 100) tasks = activate(tasks)
  return { ...cl, tasks, phase: cl.phase === 'idle' ? 'working' : cl.phase }
}

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }

export function applyTodos(cl: Checklist, todos: Todo[]): Checklist {
  const tasks = todos.slice(0, 8).map((t, i) => {
    const name = cleanName(t.content)
    const prev = cl.tasks.find(p => p.name === name && p.hasReported)
    if (t.status === 'completed') return task(`t-${i + 1}`, name, 'done', 100, true)
    if (t.status === 'in_progress') return task(`t-${i + 1}`, name, 'active', prev?.percent ?? 0, prev !== undefined)
    return task(`t-${i + 1}`, name, 'upcoming')
  })
  return { ...cl, tasks, phase: cl.phase === 'idle' || cl.phase === 'done' || cl.phase === 'stopped' ? 'working' : cl.phase }
}

export function addTask(cl: Checklist, id: string, subject: string): Checklist {
  const tasks = cl.tasks.filter(t => !isPlaceholder(t))
  return { ...cl, tasks: activate([...tasks, task(`k-${id}`, cleanName(subject), 'upcoming')]), phase: cl.phase === 'idle' ? 'working' : cl.phase }
}

export function updateTask(cl: Checklist, id: string, patch: { status?: string; subject?: string }): Checklist {
  const key = `k-${id}`
  let tasks = cl.tasks.slice()
  if (patch.status === 'deleted') tasks = tasks.filter(t => t.id !== key)
  else
    tasks = tasks.map(t => {
      if (t.id !== key) return t
      const name = patch.subject !== undefined ? cleanName(patch.subject) : t.name
      if (patch.status === 'completed') return { ...t, name, status: 'done' as const, percent: 100, hasReported: true }
      if (patch.status === 'in_progress') return { ...t, name, status: 'active' as const }
      if (patch.status === 'pending') return { ...t, name, status: 'upcoming' as const }
      return { ...t, name }
    })
  return { ...cl, tasks: activate(tasks) }
}

export function overallPercent(cl: Checklist): number {
  if (cl.tasks.length === 0) return 0
  const done = cl.tasks.filter(t => t.status === 'done').length
  const active = cl.tasks.find(t => t.status === 'active')
  return Math.round(((done + (active ? active.percent / 100 : 0)) / cl.tasks.length) * 100)
}

// ------------------------------------------------------------------- colour

function hex(c: string): [number, number, number] {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
}

function mix(a: string, b: string, t: number): string {
  const x = hex(a)
  const y = hex(b)
  const k = Math.max(0, Math.min(1, t))
  return '#' + [0, 1, 2].map(i => Math.round(x[i]! + (y[i]! - x[i]!) * k).toString(16).padStart(2, '0')).join('')
}

function ramp(stops: string[], t: number): string {
  const k = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(k))
  return mix(stops[i]!, stops[i + 1]!, k - i)
}

const HUE = [C.orange, C.pink, C.purple, C.blue]
const TITLE_HUE = [C.orange, C.pink, C.purple]
const BAR_HUE = [C.orange, C.pink]
const GREEN_HUE = [C.greenDark, C.greenLight]

/** Meter cell colours. Sweep (no percent): a comet whose hue follows its head along the track. */
export function meterCells(kind: 'done' | 'percent' | 'sweep' | 'empty', percent: number, tick: number): string[] {
  const cells: string[] = []
  const head = tick % (METER_CELLS + TAIL)
  const filled = Math.round((percent / 100) * METER_CELLS)
  for (let i = 0; i < METER_CELLS; i++) {
    const t = i / (METER_CELLS - 1)
    if (kind === 'done') cells.push(ramp(GREEN_HUE, t))
    else if (kind === 'percent') cells.push(i < filled ? ramp(BAR_HUE, i / Math.max(1, filled - 1)) : C.track)
    else if (kind === 'sweep') {
      const d = head - i
      cells.push(d >= 0 && d < TAIL ? mix(ramp(HUE, Math.min(head, METER_CELLS - 1) / (METER_CELLS - 1)), C.track, d / TAIL) : C.track)
    } else cells.push(C.track)
  }
  return cells
}

/** Main bar cell colours: orange-to-pink fill with a drifting highlight, green and still once done, dark track for the rest. */
export function barCells(pct: number, width: number, isDone: boolean, tick: number): string[] {
  const filled = Math.round((pct / 100) * width)
  const glow = !isDone && filled >= 3 ? tick % filled : -1
  return Array.from({ length: width }, (_, i) => {
    if (i >= filled) return C.track
    const base = isDone ? ramp(GREEN_HUE, i / Math.max(1, width - 1)) : ramp(BAR_HUE, i / Math.max(1, filled - 1))
    return glow >= 0 && i >= glow && i < glow + 3 ? mix(base, '#ffffff', 0.25) : base
  })
}

// ------------------------------------------------------------------- render

type Ui = ReturnType<EngineInterface['ui']['resolve']>

function Meter({ ui, colors, id }: { ui: Ui; colors: string[]; id: string }) {
  const { Box, Text } = ui
  return (
    <Box key={id} flexDirection="row" width={METER_CELLS * CELL_COLUMNS}>
      {colors.map((c, i) => (
        <Text key={`${id}-${i}`} color={c}>
          {CELL.repeat(CELL_COLUMNS)}
        </Text>
      ))}
    </Box>
  )
}

function Gradient({ ui, text, stops, id, bold }: { ui: Ui; text: string; stops: string[]; id: string; bold?: boolean }) {
  const { Box, Text } = ui
  const chars = Array.from(text)
  return (
    <Box key={id} flexDirection="row">
      {chars.map((ch, i) => (
        <Text key={`${id}-${i}`} color={ramp(stops, chars.length > 1 ? i / (chars.length - 1) : 0)} bold={bold}>
          {ch}
        </Text>
      ))}
    </Box>
  )
}

function ToggleButton({ ui, enabled, onPress }: { ui: Ui; enabled: boolean; onPress: () => void }) {
  const { Button } = ui
  return <Button key="toggle" label={enabled ? '● Clean View: ON' : '○ Clean View: OFF'} onPress={onPress} />
}

function taskLabel(t: Task, index: number, cl: Checklist): string {
  if (t.status === 'done') return 'Done'
  if (t.status === 'active') return t.hasReported ? `${t.percent}%` : 'Working'
  const firstUpcoming = cl.tasks.findIndex(x => x.status === 'upcoming')
  return index === firstUpcoming ? 'Next' : 'Up next'
}

function Band(props: { ui: Ui; cl: Checklist; tick: number; columns: number; now: number; onToggle: () => void }) {
  const { ui, cl, tick, columns, now, onToggle } = props
  const { Box, Text } = ui
  const phase = cl.phase
  const isDone = phase === 'done'
  const border = isDone ? C.green : C.pink
  const elapsed = fmtDuration((cl.finishedAt ?? now) - cl.startedAt)
  const toggle = ToggleButton({ ui, enabled: true, onPress: onToggle })

  const inner = Math.max(20, columns - 4)
  const pct = overallPercent(cl)
  const doneCount = cl.tasks.filter(t => t.status === 'done').length
  const stepNo = Math.min(cl.tasks.length, doneCount + (isDone ? 0 : 1))

  let header
  if (phase === 'needs-you')
    header = (
      <Box flexDirection="row" gap={1}>
        <Text backgroundColor={C.amber} color={C.ink} bold>{' Needs you '}</Text>
        <Text color={C.amber}>{cl.needsYouReason ?? 'Claude needs your OK to continue'}</Text>
      </Box>
    )
  else if (phase === 'stuck')
    header = <Text color={C.amber} bold>{`⚠ Stuck: ${cl.stuckReason ?? 'something went wrong'}`}</Text>
  else if (phase === 'stopped')
    header = <Text color={C.pink} bold>{`■ Stopped · ${cl.title} · you pressed Esc`}</Text>
  else if (isDone)
    header = (
      <Box flexDirection="row" gap={1}>
        <Text backgroundColor={C.green} color={C.ink} bold>{' ✓ All done '}</Text>
        {Gradient({ ui, id: "title", text: cl.title, stops: [C.greenLight, C.green], bold: true })}
      </Box>
    )
  else
    header = (
      <Box flexDirection="row" gap={1}>
        <Text color={C.pink}>{GLYPHS[tick % GLYPHS.length]}</Text>
        {Gradient({ ui, id: "title", text: cl.title, stops: TITLE_HUE, bold: true })}
      </Box>
    )
  const right = isDone ? `took ${elapsed}` : elapsed

  const head = (
    <Box key="head" flexDirection="row" justifyContent="space-between" width={inner}>
      <Box flexShrink={1}>{header}</Box>
      <Box flexDirection="row" gap={2}>
        <Text dimColor>{right}</Text>
        {toggle}
      </Box>
    </Box>
  )

  const leftLabel = isDone ? `${cl.tasks.length} of ${cl.tasks.length} steps` : `Step ${stepNo} of ${cl.tasks.length}`
  const barW = Math.max(8, inner - leftLabel.length - 6 - 2)
  const bar = barCells(pct, barW, isDone, tick)
  const overall = (
    <Box key="overall" flexDirection="row" gap={1} width={inner}>
      <Text dimColor>{leftLabel}</Text>
      <Box flexDirection="row" width={barW}>
        {bar.map((c, i) => (
          <Text key={`bar-${i}`} color={c}>{CELL}</Text>
        ))}
      </Box>
      <Text bold color={isDone ? C.green : C.pink}>{`${pct}%`}</Text>
    </Box>
  )

  const nameW = Math.max(8, Math.min(MAX_NAME, inner - 2 - METER_CELLS * CELL_COLUMNS - 9 - 4))
  const rows = cl.tasks.map((t, i) => {
    const waiting = phase === 'needs-you' && t.status === 'active'
    const mark = t.status === 'done' ? '✓' : t.status === 'active' ? (waiting ? '‖' : '●') : '○'
    const markColor = t.status === 'done' ? C.green : t.status === 'active' ? C.pink : C.dim
    const label = taskLabel(t, i, cl)
    const kind = t.status === 'done' ? 'done' : t.status === 'active' ? (t.hasReported ? 'percent' : 'sweep') : 'empty'
    const labelColor = t.status === 'active' ? C.pink : C.dim
    return (
      <Box key={t.id} flexDirection="row" gap={1} width={inner}>
        <Text color={markColor}>{mark}</Text>
        <Box width={nameW}>
          <Text wrap="truncate" bold={t.status === 'active'} dimColor={t.status !== 'active'}>{t.name}</Text>
        </Box>
        {Meter({ ui, id: `m-${t.id}`, colors: meterCells(kind, t.percent, tick) })}
        <Text color={labelColor} bold={t.status === 'active'} dimColor={t.status === 'upcoming'}>{label}</Text>
      </Box>
    )
  })

  return (
    <Box borderStyle="round" borderColor={border} paddingX={1} flexDirection="column">
      {head}
      {overall}
      {rows}
    </Box>
  )
}

// ------------------------------------------------------------------ register

const hidden = ($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) => {
  const { Box } = $.ui.resolve(e)
  return <Box display="none" />
}

let jobId = 0
let failStreak = 0
let lastError: { kind?: string; details?: string } | null = null
let wasDenied = false
let tickTimer: { cancel: () => void } | null = null

function isOn($: EngineInterface) {
  return read($, enabledAtom)
}

function syncTimer($: EngineInterface, phase: Phase) {
  if (isLive(phase) && tickTimer === null) tickTimer = $.clock.every(TICK_MS, () => void update($, tickAtom, n => n + 1))
  else if (!isLive(phase) && tickTimer !== null) {
    tickTimer.cancel()
    tickTimer = null
  }
}

async function setCl($: EngineInterface, fn: (cl: Checklist) => Checklist) {
  const next = await update($, checklistAtom, fn)
  syncTimer($, next.phase)
  return next
}

async function setEnabled($: EngineInterface, value: boolean) {
  await update($, enabledAtom, () => value)
  await $.store.set('enabled', value)
}

function clearAttention($: EngineInterface) {
  return setCl($, cl => (cl.phase === 'needs-you' || cl.phase === 'stuck' ? { ...cl, phase: 'working', needsYouReason: null, stuckReason: null } : cl))
}

function needsYou($: EngineInterface, reason: string) {
  return setCl($, cl => (isLive(cl.phase) ? { ...cl, phase: 'needs-you', needsYouReason: reason } : cl))
}

export function registerCleanView(on: Parameters<Register>[0]): void {
  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('enabled')
    if (typeof stored === 'boolean') await update($, enabledAtom, () => stored)
    await $.tool.register({
      name: 'plan_steps',
      description: 'Lay out every step of the job up front, 2 to 8 short plain-English names in order. Call this first for every request.',
      inputSchema: { type: 'object', properties: { steps: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 8 } }, required: ['steps'] },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'report_progress',
      description: 'Report progress on a step: its plain-English name and percent 0-100. Use 100 the moment the step is finished.',
      inputSchema: { type: 'object', properties: { task: { type: 'string' }, percent: { type: 'number' } }, required: ['task', 'percent'] },
      isDeferred: false,
    })
    await $.command.register({ name: 'simple', description: 'Turn Clean View on or off', argumentHint: '[on|off]' })
    syncTimer($, (await read($, checklistAtom)).phase)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!(await isOn($))) return result
    return { sections: [...result.sections, { id: 'clean-view:plan', text: PROMPT, scope: 'session' as const }] }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined || !(await isOn($))) return next(e)
    const tool = String(e.tool)
    const args = e as unknown as Record<string, unknown>

    if (tool === PLAN_TOOL) {
      const steps = Array.isArray(args.steps) ? args.steps.map(String) : []
      if (steps.length < 2) return { deny: 'plan_steps needs 2 to 8 steps.' }
      const now = await $.clock.now()
      await setCl($, cl => planSteps(cl, steps, now))
      failStreak = 0
      return { result: `Planned ${Math.min(steps.length, 8)} steps. The first one has started.` } as never
    }
    if (tool === REPORT_TOOL) {
      const pct = Math.max(0, Math.min(100, Math.round(Number(args.percent) || 0)))
      const now = await $.clock.now()
      await setCl($, cl => reportProgress(cl.phase === 'idle' ? newJob(now) : cl, String(args.task ?? ''), pct))
      return { result: `Progress noted: ${pct}%.` } as never
    }

    if (!ALWAYS_ALLOWED.has(tool) && !hasRealPlan(await read($, checklistAtom)))
      return { deny: 'Call plan_steps first: lay out 2 to 8 plain-English steps for this request, then continue. Load plan_steps with ToolSearch if needed.' }

    await clearAttention($)
    const ran = await next(e)
    if (ran.deny !== undefined) return ran

    if (ran.isError === true) {
      failStreak += 1
      if (wasDenied) {
        wasDenied = false
        await setCl($, cl => (isLive(cl.phase) ? { ...cl, phase: 'stuck', stuckReason: 'you said no to a step, so Claude paused' } : cl))
      } else if (failStreak >= 3)
        await setCl($, cl => (isLive(cl.phase) ? { ...cl, phase: 'stuck', stuckReason: 'a step keeps failing, Claude is trying another way' } : cl))
    } else {
      failStreak = 0
      await clearAttention($)
      if (tool === 'TodoWrite' && Array.isArray(args.todos)) await setCl($, cl => applyTodos(cl, args.todos as Todo[]))
      else if (tool === 'TaskCreate') {
        const id = String((ran.result as { task?: { id?: unknown } } | undefined)?.task?.id ?? Date.now())
        await setCl($, cl => addTask(cl, id, String(args.subject ?? '')))
      } else if (tool === 'TaskUpdate')
        await setCl($, cl => updateTask(cl, String(args.taskId ?? ''), { status: args.status as string | undefined, subject: args.subject as string | undefined }))
      else if (tool === 'AskUserQuestion') await needsYou($, 'Claude has a question for you')
    }
    return ran
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'clean-view: its plan check failed, call plan_steps first.' }))

  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (!(await isOn($)) || e.text.trim() === '' || e.text.trim().startsWith('/')) return result
    const before = await read($, checklistAtom)
    if (isLive(before.phase)) return result
    failStreak = 0
    wasDenied = false
    lastError = null
    const id = ++jobId
    const now = await $.clock.now()
    await setCl($, () => newJob(now))
    void (async () => {
      for (const model of TITLE_MODELS) {
        try {
          const res = await $.model.complete({
            model,
            effort: 'low',
            maxTokens: 30,
            system: 'Reply with only a 2 to 6 word plain-English job name that starts with a verb. No quotes, no punctuation, no file names.',
            prompt: e.text.slice(0, 600),
          })
          if (id !== jobId) return
          if (!res.isAnswered) continue
          const title = cleanName((res.text.split('\n')[0] ?? '').replace(/^["'\s]+|["'.!?,;:\s]+$/g, ''))
          await setCl($, cl => (id === jobId ? { ...cl, title } : cl))
          return
        } catch {
          /* try the next model; the placeholder title stays if none answers */
        }
      }
    })()
    return result
  })

  on('classic.Notification', async ($, e, next) => {
    if (/permission|elicitation/i.test(e.notification_type ?? '')) await needsYou($, 'Claude needs your OK to continue')
    return next(e)
  })

  on('classic.PermissionDenied', async ($, e, next) => {
    wasDenied = true
    await setCl($, cl => (isLive(cl.phase) ? { ...cl, phase: 'stuck', stuckReason: 'you said no to a step, so Claude paused' } : cl))
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    lastError = { kind: String(e.error), details: e.error_details }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || !(await isOn($))) return result
    const now = await $.clock.now()
    const cl = await read($, checklistAtom)
    if (cl.phase === 'idle') return result
    if (e.reason === 'error') {
      const reason = errorSentence(lastError?.kind, lastError?.details)
      await setCl($, c => ({ ...c, phase: 'stuck', stuckReason: reason }))
    } else if (e.reason === 'refusal') await setCl($, c => ({ ...c, phase: 'stuck', stuckReason: "Claude couldn't help with that request" }))
    else if (e.reason === 'aborted') await setCl($, c => ({ ...c, phase: 'stopped', finishedAt: now }))
    else if (hasUnfinished(cl)) await setCl($, c => ({ ...c, phase: 'needs-you', needsYouReason: 'Claude is waiting for your reply' }))
    else {
      await setCl($, c => ({ ...c, phase: 'done', finishedAt: now, isCollapsed: false }))
    }
    lastError = null
    return result
  })

  on('command.run', { command: 'simple' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const now = arg === 'on' ? true : arg === 'off' ? false : !(await isOn($))
    await setEnabled($, now)
    return { text: now ? 'Clean View is on.' : 'Clean View is off. Tool rows are back.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const enabled = await isOn($)
    const cl = await read($, checklistAtom)
    const tick = await read($, tickAtom)
    const ui = $.ui.resolve(e)
    const { Box } = ui
    const toggle = async () => {
      const value = !(await read($, enabledAtom))
      await setEnabled($, value)
      $.ui.toast(value ? 'Clean View on' : 'Clean View off')
    }
    if (!enabled || cl.phase === 'idle') {
      return (
        <Box flexDirection="row" justifyContent="flex-end" width={Math.max(20, e.props.bodyColumns)}>
          {ToggleButton({ ui, enabled, onPress: () => void toggle() })}
        </Box>
      )
    }
    return Band({ ui, cl, tick, columns: e.props.bodyColumns, now: await $.clock.now(), onToggle: () => void toggle() })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => ((await isOn($)) ? hidden($, e) : next(e)))
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => ((await isOn($)) ? hidden($, e) : next(e)))
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => ((await isOn($)) ? hidden($, e) : next(e)))
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => ((await isOn($)) ? next({ ...e, props: { ...e.props, hint: '' } }) : next(e)))
}
