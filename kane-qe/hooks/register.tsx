// kane-qe v2: watches kane-cli and shows it: a band of three rows above the prompt (with the mascot),
// a pane for runs and assurance, and a nudge to test what Claude just changed.
// The mod never starts a test: Claude runs kane-cli, the mod reads what kane-cli leaves on disk.
import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderSurface, TextProps } from 'claude-code'
import type { AfterChange, Assurance, Change, HistoryEntry, Kind, Offer, Run, Status, Step, UseCase, View } from '../types'
import { adapt, splitLines } from './adapter'
import type { Ev } from './adapter'
import { RANK } from './adapter'
import { PICTURE, RASTER, STEP_MS, mascotSvg, pixelFrame, poseAt, rasterCells } from './mascot'
import {
  C,
  HISTORY_MAX,
  ORDER,
  band,
  bar,
  cardFailures,
  cardHeader,
  currentStep,
  cells,
  cut,
  debt,
  draftPrompt,
  elapsed,
  firstLine,
  fmt,
  fold,
  foldMember,
  gapsPrompt,
  gridSince,
  historyDetail,
  historyEntry,
  isRunCommand,
  isTrackedEdit,
  kindLine,
  latest,
  labelFromCommand,
  leaves,
  newRun,
  nm,
  nowText,
  objectiveFrom,
  onGrid,
  parseCoverGaps,
  ago,
  savedTestsFor,
  startUrl,
  summary,
  tally,
  usePalette,
} from './model'
import type { Item, Row, Span } from './model'
import { MAX_READ, afterBytes, inside, parsePointer, utf8Len } from './sources'
import type { Pointer } from './sources'

const PANE = 'kane-qe'

const runsAtom = atom({ plugin: 'kane-qe', key: 'runs' } as const, [] as Run[])
const viewAtom = atom({ plugin: 'kane-qe', key: 'view' } as const, { tab: 'runs', open: '' } as View)
const tickAtom = atom({ plugin: 'kane-qe', key: 'tick' } as const, 0)
const assuranceAtom = atom({ plugin: 'kane-qe', key: 'assurance' } as const, { state: 'unknown' } as Assurance)
const changeAtom = atom({ plugin: 'kane-qe', key: 'change' } as const, null as Change | null)
const offerAtom = atom({ plugin: 'kane-qe', key: 'offer' } as const, null as Offer | null)
const modeAtom = atom({ plugin: 'kane-qe', key: 'mode' } as const, '' as '' | AfterChange)
const lastAtom = atom({ plugin: 'kane-qe', key: 'last' } as const, null as HistoryEntry | null)
const historyAtom = atom({ plugin: 'kane-qe', key: 'history' } as const, [] as HistoryEntry[])

type Kit = Pick<Elements['mobile'], 'Box' | 'Text' | 'Button'>
type Table = Elements[RenderSurface]
type Press = (action: string) => void

function glyphOf(s: Status): [string, string] {
  const all: Record<Status, [string, string]> = { running: ['◉', C.cyan], passed: ['✓', C.mint], failed: ['✗', C.coral], pending: ['○', C.dim] }
  return all[s]
}

// ── module state: it starts over on a reload; what must last is in `$.state` / `$.store` ──

let setting: AfterChange = 'offer'
let kane: string[] = ['kane-cli']
let projectDir = ''
let activeDir = ''
/** One per file being followed: a run's own stream, or a suite member's. */
type Watch = { id: string; path: string; pointer?: string; pid?: number; bytes: number; rest: string; done: boolean; member?: string; parent?: string; closing?: boolean }
const watches = new Map<string, Watch>()
const seenPointers = new Set<string>()
/** kane-cli commands Claude ran, to name the runs they start. */
const commands: { label: string; surface: Kind; at: number; used: boolean; toolUseId?: string }[] = []
/** Evidence viewers this session started, by pack: the link each one printed. */
const viewers = new Map<string, string>()
/** Ended runs whose evidence pack is still being looked for, by run id: when to stop looking. */
const seeking = new Map<string, number>()
let polling = false
const sites = new Set<string>()
let frame = 0
let thinking = false
let remote = false

// ── drawing ─────────────────────────────────────────────────────────────

function text(ui: Kit, s: Span) {
  const p: TextProps = {}
  if (s.c !== undefined) p.color = s.c
  if (s.bg !== undefined) p.backgroundColor = s.bg
  if (s.b) p.bold = true
  if (s.d) p.dimColor = true
  // A chip: the fill is on a box as well, for surfaces that paint no background behind text.
  if (s.bg !== undefined) return <ui.Box backgroundColor={s.bg}>{<ui.Text {...p}>{s.t}</ui.Text>}</ui.Box>
  return <ui.Text {...p}>{s.t}</ui.Text>
}

const item = (ui: Kit, i: Item) => (Array.isArray(i) ? <ui.Box flexDirection="row">{i.filter(s => s.t !== '').map(s => text(ui, s))}</ui.Box> : text(ui, i))

function line(ui: Kit, press: Press, r: Row) {
  if (r.items.length === 0 && !r.button) return <ui.Text> </ui.Text>
  return (
    <ui.Box flexDirection="row" gap={1}>
      {r.items.map(i => item(ui, i))}
      {r.button ? <ui.Button key={r.button.key} label={r.button.label} variant="primary" onPress={() => press(r.button?.act ?? '')} /> : null}
    </ui.Box>
  )
}

// The surface decides, not the table: a surface with no cell grid still answers `Raster`, as an empty box.
function mascot(table: Table, surface: RenderSurface, think: boolean, n: number) {
  if (surface === 'terminal' && 'Raster' in table) return <table.Raster key="mascot" columns={RASTER.columns} rows={RASTER.rows} cells={rasterCells(pixelFrame(poseAt(think, n)))} />
  // A plain image, redrawn per frame: an animated SVG needs a framed document, which paints its own backdrop.
  if ('Svg' in table) return <table.Svg source={mascotSvg(poseAt(think, n))} alt="kane mascot" width={PICTURE.width} height={PICTURE.height} />
  return <table.Text color={C.purple}>kane</table.Text>
}

const glyph = (ui: Kit, s: Status) => <ui.Text color={glyphOf(s)[1]}>{glyphOf(s)[0]}</ui.Text>

/** A label and its text side by side, so a wrapped text keeps its column. */
function fact(ui: Kit, label: string, value: string, color?: string) {
  return (
    <ui.Box flexDirection="row" gap={1}>
      <ui.Box width={7} flexShrink={0}>
        <ui.Text dimColor>{label}</ui.Text>
      </ui.Box>
      <ui.Box flexGrow={1} flexShrink={1}>
        {color ? <ui.Text color={color}>{value}</ui.Text> : <ui.Text>{value}</ui.Text>}
      </ui.Box>
    </ui.Box>
  )
}

const meta = (r: Run) => [r.kind, r.target].filter(Boolean).join(' · ')

function runCard(ui: Kit, press: Press, r: Run, now: number, width: number) {
  const isSuite = r.kind === 'testrun' && r.members
  const c = isSuite ? tally(r.members ?? []) : undefined
  const second = c ? (onGrid(r) ? `${c.total} test${c.total === 1 ? '' : 's'} on the grid · ${gridSince(r, now)}` : `${c.passed + c.failed} of ${c.total} tests done${c.running ? ` · ${c.running} running` : ''}${c.failed ? ` · ${c.failed} failed` : ''}`) : summary(r)
  return (
    <ui.Box key={`card-${r.id}`} flexDirection="column" borderStyle="round" borderColor={r.status === 'failed' ? C.coral : C.dim} paddingX={1}>
      <ui.Box flexDirection="row" gap={1}>
        {glyph(ui, r.status)}
        <ui.Button key={`run-${r.id}`} label={cut(r.label, Math.max(16, width - 16))} plain onPress={() => press(`run:${r.id}`)} />
        <ui.Text dimColor>{r.status === 'pending' ? '' : fmt(elapsed(r, now))}</ui.Text>
      </ui.Box>
      <ui.Text>{cut(second, Math.max(20, width * 2))}</ui.Text>
      {meta(r) ? <ui.Text dimColor>{meta(r)}</ui.Text> : null}
    </ui.Box>
  )
}

function memberRow(ui: Kit, press: Press, r: Run, now: number, width: number) {
  const nameRoom = Math.max(12, Math.floor(width * 0.4))
  const stepRoom = Math.max(10, width - nameRoom - 14)
  const tail = r.status === 'pending' ? '' : r.status === 'running' ? `${cut(nowText(r), stepRoom)} · ${fmt(elapsed(r, now))}` : fmt(elapsed(r, now))
  return (
    <ui.Box key={`member-${r.id}`} flexDirection="row" gap={1}>
      {glyph(ui, r.status)}
      <ui.Button key={`run-${r.id}`} label={cut(nm(r), nameRoom)} plain onPress={() => press(`run:${r.id}`)} />
      <ui.Text dimColor>{tail}</ui.Text>
    </ui.Box>
  )
}

const sortRuns = (list: readonly Run[]) => [...list].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.startedAt - a.startedAt)
/** A suite's tests by state, each state in the plan's order. */
const sortMembers = (list: readonly Run[]) => list.map((m, i) => ({ m, i })).sort((a, b) => ORDER[a.m.status] - ORDER[b.m.status] || a.i - b.i).map(x => x.m)

/** Where a remote suite is running: the grid, its job, and why nothing moves until it ends. */
function gridFacts(ui: Kit, s: Run) {
  const r = s.remote ?? {}
  return (
    <ui.Box flexDirection="column">
      {fact(ui, 'grid', [r.backend ?? 'remote', r.jobId ? `job ${r.jobId}` : ''].filter(Boolean).join(' · '))}
      {r.jobUrl ? fact(ui, 'link', r.jobUrl) : null}
      {onGrid(s) ? <ui.Text dimColor>The grid reports each test when the job ends. Open the link to watch it there.</ui.Text> : null}
    </ui.Box>
  )
}

function suiteView(ui: Kit, press: Press, s: Run, now: number, width: number, back: boolean) {
  const c = tally(s.members ?? [])
  return (
    <ui.Box flexDirection="column">
      <ui.Box flexDirection="row" gap={1}>
        {back ? <ui.Button key="back" label="‹ Runs" plain dimColor onPress={() => press('back')} /> : null}
        <ui.Text bold>{cut(s.label, width - 10)}</ui.Text>
      </ui.Box>
      <ui.Text dimColor>{onGrid(s) ? `${c.total ? `${c.total} test${c.total === 1 ? '' : 's'} on the grid · ` : ''}${gridSince(s, now)}` : c.total ? `${c.passed + c.failed} of ${c.total} done · ${c.running} running · ${c.pending} waiting` : 'planning the suite'}</ui.Text>
      {s.remote ? gridFacts(ui, s) : null}
      <ui.Text> </ui.Text>
      {sortMembers(s.members ?? []).map(m => memberRow(ui, press, m, now, width))}
    </ui.Box>
  )
}

function runsView(ui: Kit, press: Press, runs: readonly Run[], now: number, width: number, last: HistoryEntry | null) {
  if (runs.length === 0) {
    return (
      <ui.Box flexDirection="column">
        <ui.Text dimColor>No kane-cli run in this session yet. Ask Claude to test something, or run kane-cli in a terminal here: it shows up by itself.</ui.Text>
        {last ? <ui.Text dimColor>{`last run ${last.status === 'passed' ? '✓' : '✗'} ${nm(last)} · ${ago(now - last.at)}`}</ui.Text> : null}
      </ui.Box>
    )
  }
  const only = runs.length === 1 ? runs[0] : undefined
  if (only?.kind === 'testrun' && only.members) return suiteView(ui, press, only, now, width, false)
  return <ui.Box flexDirection="column">{sortRuns(runs).map(r => runCard(ui, press, r, now, width))}</ui.Box>
}

function stepTime(s: Step, now: number): string {
  if (!s.startedAt) return ''
  if (s.status === 'running') return fmt((now - s.startedAt) / 1000)
  return s.endedAt ? fmt((s.endedAt - s.startedAt) / 1000) : ''
}

function runDetail(ui: Kit, press: Press, r: Run, now: number, width: number) {
  const tone = r.status === 'failed' ? C.coral : r.status === 'passed' ? C.mint : C.purple
  const ended = r.status === 'passed' || r.status === 'failed'
  const status = [fmt(elapsed(r, now)), r.kind, r.target, ended && r.credits !== undefined ? `${Math.round(r.credits * 10) / 10} credits` : ''].filter(Boolean).join(' · ')
  const failing = r.status === 'failed' ? currentStep(r) : undefined
  const kind = kindLine(r)
  return (
    <ui.Box flexDirection="column">
      <ui.Box flexDirection="row" gap={1}>
        <ui.Button key="back" label="‹ Runs" plain dimColor onPress={() => press('back')} />
        <ui.Text bold>{cut(r.label, width - 10)}</ui.Text>
      </ui.Box>
      <ui.Box flexDirection="row" gap={1}>
        <ui.Text color={tone} bold>
          {r.status === 'pending' ? 'waiting' : r.status}
        </ui.Text>
        <ui.Text dimColor>{r.status === 'pending' ? '' : status}</ui.Text>
      </ui.Box>
      {r.newer ? <ui.Text dimColor>this kane-cli is newer than the mod: step detail is not read</ui.Text> : null}
      {r.waiting ? fact(ui, 'asks', r.waiting, C.orange) : null}
      {r.skipped ? <ui.Text dimColor>{`${r.skipped} line${r.skipped === 1 ? '' : 's'} of its stream could not be read and ${r.skipped === 1 ? 'was' : 'were'} skipped`}</ui.Text> : null}
      <ui.Text> </ui.Text>
      {r.status === 'failed' && r.failure?.why ? fact(ui, 'why', r.failure.why) : null}
      {r.status === 'failed' && kind ? fact(ui, 'kind', kind) : null}
      {r.status === 'failed' && r.failure?.where ? fact(ui, 'where', r.failure.where) : null}
      {r.status === 'failed' ? <ui.Text> </ui.Text> : null}
      {r.steps.map((s, i) => {
        if (r.kind === 'run' && s.status === 'pending') return null
        const open = s.status === 'running' || s === failing
        return (
          <ui.Box key={`step-${i}`} flexDirection="column">
            <ui.Box flexDirection="row" gap={1}>
              {glyph(ui, s.status)}
              <ui.Box flexShrink={1}>
                <ui.Text bold={open} dimColor={s.status === 'pending'}>
                  {s.text || (s.status === 'running' ? 'working…' : `step ${i + 1}`)}
                </ui.Text>
              </ui.Box>
              <ui.Text dimColor>{stepTime(s, now)}</ui.Text>
            </ui.Box>
            {open ? (
              <ui.Box flexDirection="column" paddingLeft={4}>
                {s.think ? fact(ui, 'think', s.think) : null}
                {s.act ? fact(ui, 'act', s.act) : null}
                {(s.checks ?? []).map(c => fact(ui, 'check', `${c.ok ? '✓' : '✗'} ${c.text}`, c.ok ? C.mint : C.coral))}
              </ui.Box>
            ) : null}
          </ui.Box>
        )
      })}
      {ended && r.sessionDir ? <ui.Text> </ui.Text> : null}
      {ended && r.sessionDir ? <ui.Button key="evidence" label="Open evidence" variant="primary" onPress={() => press(`evidence:${r.id}`)} /> : null}
    </ui.Box>
  )
}

function offerView(ui: Kit, press: Press, o: Offer | null, change: Change | null, now: number, width: number) {
  const files = o?.files ?? change?.files ?? []
  const saved = o?.saved ?? []
  const hasDraft = !!(o && (o.drafting || o.objective || o.note))
  return (
    <ui.Box flexDirection="column">
      <ui.Box flexDirection="row" gap={1}>
        <ui.Button key="back" label="‹ Runs" plain dimColor onPress={() => press('back')} />
        <ui.Text bold>Test this change</ui.Text>
      </ui.Box>
      <ui.Text color={C.orange}>{change ? '⚠ This change has not been tested' : 'A kane-cli run has covered this change'}</ui.Text>
      <ui.Text> </ui.Text>
      {files.slice(0, 8).map((f, i) => fact(ui, i === 0 ? 'changed' : '', f.startsWith(`${projectDir}/`) ? f.slice(projectDir.length + 1) : f))}
      {files.length > 8 ? <ui.Text dimColor>{`        +${files.length - 8} more`}</ui.Text> : null}
      <ui.Text> </ui.Text>
      {hasDraft ? (
        <ui.Box flexDirection="column">
          <ui.Text bold>Suggested objective</ui.Text>
          {o?.drafting ? <ui.Text dimColor>Claude is drafting one…</ui.Text> : o?.objective ? <ui.Text>{o.objective}</ui.Text> : <ui.Text dimColor>{o?.note ?? ''}</ui.Text>}
          <ui.Text> </ui.Text>
        </ui.Box>
      ) : null}
      {saved.length ? (
        <ui.Box flexDirection="column">
          <ui.Text bold>Saved tests that touch this</ui.Text>
          {saved.slice(0, 4).map(t => {
            const last = o?.last?.[t]
            return (
              <ui.Box key={`saved-${t}`} flexDirection="row" gap={1}>
                <ui.Box flexShrink={1}>
                  <ui.Text dimColor>{(() => {
                    const tail = last ? ` · last ${last.status === 'passed' ? '✓' : '✗'} ${ago(now - last.at)}` : ''
                    return `${cut(t.replace(/_test\.md$/, ''), Math.max(12, width - tail.length - 12))}${tail}`
                  })()}</ui.Text>
                </ui.Box>
                <ui.Button key={`saved-run-${t}`} label="Run it" onPress={() => press(`saved:${t}`)} />
              </ui.Box>
            )
          })}
          <ui.Text> </ui.Text>
        </ui.Box>
      ) : null}
      <ui.Box flexDirection="row" gap={1}>
        {o?.objective ? <ui.Button key="offer-run" label="Run the objective" variant="primary" onPress={() => press('offer-run')} /> : null}
        {!hasDraft ? <ui.Button key="offer-draft" label="Draft a new objective" onPress={() => press('offer-draft')} /> : null}
        <ui.Button key="offer-skip" label="Not now" onPress={() => press('offer-skip')} />
      </ui.Box>
    </ui.Box>
  )
}

/** One use case: its bars, then what it still owes, to design first and to run after, each with kane-cli's own next command. */
function useCaseView(ui: Kit, press: Press, u: UseCase) {
  const pct = (n: number | undefined) => (n === undefined ? '   –' : `${String(n).padStart(3)}%`)
  const listed = u.pending.length
  const owed = u.toDesign + u.toCover
  const group = (stage: 'design' | 'cover', title: string) => {
    const rows = u.pending.filter(p => p.stage === stage)
    if (!rows.length) return null
    // Rows that share one reason and one next command say them once, under the list.
    const shared = rows.length > 1 && rows.every(p => p.why === rows[0]!.why && p.command === rows[0]!.command)
    return (
      <ui.Box key={`owed-${stage}`} flexDirection="column">
        <ui.Text bold>{title}</ui.Text>
        {rows.map((p, i) => (
          <ui.Box key={`owed-${stage}-${i}`} flexDirection="column">
            <ui.Box flexDirection="row" gap={1}>
              <ui.Text color={p.risk === 'high' ? C.coral : C.dim}>{p.risk === 'high' ? '▲' : '·'}</ui.Text>
              <ui.Box flexShrink={1}>
                <ui.Text>{p.title}</ui.Text>
              </ui.Box>
            </ui.Box>
            {shared ? null : (
              <ui.Box flexDirection="column" paddingLeft={2}>
                {p.why ? fact(ui, 'why', p.why) : null}
                {p.command ? fact(ui, 'next', p.command, C.purple) : null}
              </ui.Box>
            )}
          </ui.Box>
        ))}
        {shared && rows[0]!.why ? fact(ui, 'why', rows[0]!.why) : null}
        {shared && rows[0]!.command ? fact(ui, 'next', rows[0]!.command, C.purple) : null}
        <ui.Text> </ui.Text>
      </ui.Box>
    )
  }
  return (
    <ui.Box flexDirection="column">
      <ui.Box flexDirection="row" gap={1}>
        <ui.Button key="uc-back" label="‹ Assurance" plain dimColor onPress={() => press('uc-back')} />
        <ui.Text bold>{u.id}</ui.Text>
      </ui.Box>
      {u.title ? <ui.Text>{u.title}</ui.Text> : null}
      <ui.Box flexDirection="row" gap={1}>
        {u.risk ? <ui.Text color={u.risk === 'high' ? C.coral : C.dim}>{`${u.risk} risk`}</ui.Text> : null}
        {debt(u).map(s => text(ui, s))}
      </ui.Box>
      <ui.Box flexDirection="row" gap={1}>
        <ui.Text dimColor>designed</ui.Text>
        {item(ui, bar(12, u.designed / 100, C.yellow))}
        <ui.Text>{pct(u.designed)}</ui.Text>
      </ui.Box>
      <ui.Box flexDirection="row" gap={1}>
        <ui.Text dimColor>proven  </ui.Text>
        {item(ui, bar(12, (u.proven ?? 0) / 100, C.yellow))}
        <ui.Text>{pct(u.proven)}</ui.Text>
      </ui.Box>
      <ui.Text> </ui.Text>
      {owed === 0 ? <ui.Text dimColor>Nothing owed: every criterion has a test{u.proven === 100 ? ' and a passing run' : ''}.</ui.Text> : null}
      {group('design', 'To design')}
      {group('cover', 'To run')}
      {owed > listed ? <ui.Text dimColor>{`+${owed - listed} more: kane-cli cover gaps ${u.id}`}</ui.Text> : null}
      {owed > 0 ? <ui.Button key="uc-close" label="Close these gaps with Claude" variant="primary" onPress={() => press(`uc-close:${u.id}`)} /> : null}
    </ui.Box>
  )
}

/** Finished runs the mod has seen in this project, newest first. */
function historyView(ui: Kit, list: readonly HistoryEntry[], now: number, width: number) {
  if (list.length === 0) return <ui.Text dimColor>No finished kane-cli run seen in this project yet. Each run is kept here when it ends.</ui.Text>
  const c = { passed: list.filter(x => x.status === 'passed').length, failed: list.filter(x => x.status === 'failed').length }
  return (
    <ui.Box flexDirection="column">
      <ui.Text dimColor>{`last ${list.length} run${list.length === 1 ? '' : 's'} here · ${c.passed} passed · ${c.failed} failed`}</ui.Text>
      <ui.Text> </ui.Text>
      {list.map((entry, i) => (
        <ui.Box key={`history-${i}`} flexDirection="column">
          <ui.Box flexDirection="row" gap={1}>
            {glyph(ui, entry.status)}
            <ui.Box flexShrink={1}>
              <ui.Text bold={entry.status === 'failed'}>{cut(nm(entry), Math.max(16, width - 14))}</ui.Text>
            </ui.Box>
            <ui.Text dimColor>{ago(now - entry.at)}</ui.Text>
          </ui.Box>
          <ui.Box paddingLeft={2}>
            <ui.Text dimColor>{cut([entry.kind, historyDetail(entry)].filter(Boolean).join(' · '), Math.max(20, width * 2 - 4))}</ui.Text>
          </ui.Box>
        </ui.Box>
      ))}
    </ui.Box>
  )
}

function assureView(ui: Kit, press: Press, a: Assurance, now: number, open?: string) {
  if (a.state === 'unknown') return <ui.Text dimColor>Reading the requirement store…</ui.Text>
  const opened = a.state === 'ready' && open ? a.useCases.find(u => u.id === open) : undefined
  if (opened) return useCaseView(ui, press, opened)
  if (a.state === 'none') {
    return (
      <ui.Box flexDirection="column" borderStyle="round" borderColor={C.yellow} paddingX={1}>
        <ui.Text color={C.yellow} bold>
          Assurance is not set up
        </ui.Text>
        <ui.Text dimColor>Assurance turns a requirement into use cases, designs tests for them, and tracks which ones a real run has proven.</ui.Text>
        <ui.Text> </ui.Text>
        <ui.Text dimColor>○ ingest ── ○ extract ── ○ design ── ○ prove</ui.Text>
        <ui.Text> </ui.Text>
        <ui.Button key="setup" label="Set it up with Claude" variant="primary" onPress={() => press('setup')} />
      </ui.Box>
    )
  }
  const pct = (n: number | undefined) => (n === undefined ? '   –' : `${String(n).padStart(3)}%`)
  const debtLine = [a.failing ? `${a.failing} failing` : '', a.blocked ? `${a.blocked} blocked` : '', a.lastRunAt ? `run ${ago(now - a.lastRunAt)}` : a.provenPct === undefined ? 'nothing run yet' : ''].filter(Boolean).join(' · ')
  return (
    <ui.Box flexDirection="column">
      <ui.Box flexDirection="row" gap={1}>
        <ui.Text dimColor>designed</ui.Text>
        {item(ui, bar(24, a.designedPct / 100, C.yellow))}
        <ui.Text color={C.yellow} bold>{`${a.designedPct}%`}</ui.Text>
      </ui.Box>
      <ui.Box flexDirection="row" gap={1}>
        <ui.Text dimColor>proven  </ui.Text>
        {item(ui, bar(24, (a.provenPct ?? 0) / 100, C.yellow))}
        <ui.Text color={C.yellow} bold>
          {a.provenPct === undefined ? '–' : `${a.provenPct}%`}
        </ui.Text>
      </ui.Box>
      {debtLine ? <ui.Text dimColor>{debtLine}</ui.Text> : null}
      <ui.Text> </ui.Text>
      {a.useCases.map(u => (
        <ui.Box key={`uc-${u.id}`} flexDirection="column" borderStyle="round" borderColor={C.dim} paddingX={1}>
          <ui.Box flexDirection="row" gap={1}>
            <ui.Button key={`uc-${u.id}`} label={u.id} plain onPress={() => press(`uc:${u.id}`)} />
            {u.title ? (
              <ui.Box flexShrink={1}>
                <ui.Text>{u.title}</ui.Text>
              </ui.Box>
            ) : null}
            {debt(u).map(s => text(ui, s))}
          </ui.Box>
          <ui.Box flexDirection="row" gap={1}>
            <ui.Text dimColor>designed</ui.Text>
            {item(ui, bar(6, u.designed / 100, C.yellow))}
            <ui.Text>{pct(u.designed)}</ui.Text>
            <ui.Text dimColor>proven</ui.Text>
            {item(ui, bar(6, (u.proven ?? 0) / 100, C.yellow))}
            <ui.Text>{pct(u.proven)}</ui.Text>
          </ui.Box>
        </ui.Box>
      ))}
    </ui.Box>
  )
}

/** A run Claude started, as a card in the chat in place of its shell row: one line while it runs, then its result. */
function chatCard(table: Table, surface: RenderSurface, press: Press, r: Run, now: number, columns: number, clickable: boolean) {
  const ui: Kit = table
  if (r.status === 'running' || r.status === 'pending') {
    const suite = r.kind === 'testrun' && r.members ? cardHeader(r, now, columns).result : undefined
    return (
      <ui.Box flexDirection="row" gap={1} marginTop={1}>
        <ui.Text color={C.cyan}>◉</ui.Text>
        <ui.Text color={C.purple} bold>
          kane
        </ui.Text>
        <ui.Text dimColor>·</ui.Text>
        <ui.Text bold>{cut(nm(r), Math.max(12, Math.floor(columns / 3)))}</ui.Text>
        {suite ? suite.map(s => text(ui, s)) : <ui.Text dimColor>{fmt(elapsed(r, now))}</ui.Text>}
        {suite ? null : <ui.Text dimColor>·</ui.Text>}
        {suite ? null : (
          <ui.Box flexShrink={1}>
            <ui.Text>{cut(nowText(r), Math.max(10, columns - Math.floor(columns / 3) - 22))}</ui.Text>
          </ui.Box>
        )}
      </ui.Box>
    )
  }
  const width = Math.max(48, Math.min(88, columns - 2))
  const inner = width - RASTER.columns - 6
  const head = cardHeader(r, now, inner)
  const isSuite = r.kind === 'testrun' && !!r.members
  const failures = isSuite ? cardFailures(r) : undefined
  const kind = kindLine(r)
  const steps = r.steps.filter(s => s.text || s.status !== 'pending').length
  return (
    <ui.Box marginTop={1} width={width} flexDirection="row" gap={2} borderStyle="round" borderColor={r.status === 'failed' ? C.coral : C.mint} paddingX={1}>
      {mascot(table, surface, false, 0)}
      <ui.Box flexDirection="column" flexGrow={1} flexShrink={1}>
        <ui.Box flexDirection="row" justifyContent="space-between" gap={2}>
          <ui.Box flexDirection="row" gap={1} flexShrink={1}>
            <ui.Text color={C.purple} bold>
              kane
            </ui.Text>
            <ui.Text dimColor>·</ui.Text>
            <ui.Text bold>{head.name}</ui.Text>
          </ui.Box>
          <ui.Box flexDirection="row" gap={1} flexShrink={0}>
            {head.result.map((s, i) => (i === 0 ? text(ui, s) : <ui.Box flexDirection="row" gap={1}>{[<ui.Text dimColor>·</ui.Text>, text(ui, s)]}</ui.Box>))}
          </ui.Box>
        </ui.Box>
        {isSuite ? item(ui, cells((r.members ?? []).map(m => m.status))) : null}
        {failures?.rows.map(m => (
          <ui.Box key={`card-fail-${m.id}`} flexDirection="row" gap={1}>
            <ui.Text color={C.coral}>{`✗ ${cut(nm(m), 24)}`}</ui.Text>
            <ui.Text dimColor>{m.failure?.where ? 'failed on' : 'failed'}</ui.Text>
            <ui.Box flexShrink={1}>
              <ui.Text>{cut(m.failure?.where ?? m.failure?.why ?? '', Math.max(10, inner - 38))}</ui.Text>
            </ui.Box>
          </ui.Box>
        ))}
        {failures && failures.more ? <ui.Text dimColor>{`+${failures.more} more`}</ui.Text> : null}
        {!isSuite && r.status === 'failed' && r.failure?.where ? fact(ui, 'on', cut(firstLine(r.failure.where), Math.max(20, inner * 2 - 8))) : null}
        {!isSuite && r.status === 'failed' && r.failure?.why ? fact(ui, 'why', r.failure.why) : null}
        {!isSuite && r.status === 'failed' && kind ? fact(ui, 'kind', kind) : null}
        {!isSuite && r.status === 'passed' && steps ? <ui.Text dimColor>{`${steps} step${steps === 1 ? '' : 's'}`}</ui.Text> : null}
        {clickable ? <ui.Text> </ui.Text> : null}
        {clickable ? (
          <ui.Box flexDirection="row" gap={1}>
            {isSuite || r.status === 'failed' ? <ui.Button key="card-steps" label={isSuite ? 'View tests' : 'View steps'} onPress={() => press(`steps:${r.id}`)} /> : null}
            {r.evidence ? <ui.Button key="card-evidence" label="View evidence" variant="primary" onPress={() => press(`evidence:${r.id}`)} /> : null}
          </ui.Box>
        ) : r.evidence ? (
          fact(ui, 'evidence', r.evidence)
        ) : null}
      </ui.Box>
    </ui.Box>
  )
}

// ── reading kane-cli ─────────────────────────────────────────────────────

/** Opened only by something the person did, and brought to the front: Claude Code opens its Diff pane in the
 *  same dock after an edit, and re-opening a pane that is already open does not raise it, so a hidden one is
 *  closed and opened again (what it shows lives in the atoms, so nothing is lost). */
async function openPane($: EngineInterface) {
  const mine = (await $.ui.panes().catch(() => [])).find(p => p.id === PANE)
  if (mine && !mine.isShown) await $.ui.close({ id: PANE }).catch(() => undefined)
  return $.ui.open({ id: PANE, title: 'Kane', columns: 58, rows: 28, focus: true })
}

const modeOf = (m: '' | AfterChange): AfterChange => (m === '' ? setting : m)

async function alive($: EngineInterface, pid: number | undefined): Promise<boolean> {
  if (!pid) return false
  const r = await $.process.run(['kill', '-0', String(pid)], { timeoutMs: 3000 }).catch(() => undefined)
  return r?.exitCode === 0
}

/** The text a file gained since the last read, as whole lines. */
async function readNew($: EngineInterface, w: Watch): Promise<string[]> {
  const st = await $.fs.stat(w.path).catch(() => undefined)
  if (!st || st.size <= w.bytes) return []
  let chunk: string
  if (st.size > MAX_READ) {
    const r = await $.process.run(['tail', '-c', `+${w.bytes + 1}`, w.path], { timeoutMs: 10_000 }).catch(() => undefined)
    if (!r || r.exitCode !== 0) return []
    chunk = r.stdout
  } else {
    const all = await $.fs.read(w.path).catch(() => undefined)
    if (all === undefined) return []
    chunk = afterBytes(all, w.bytes)
  }
  w.bytes += utf8Len(chunk)
  const { lines, rest } = splitLines(w.rest + chunk)
  w.rest = rest
  return lines
}

/** The label Claude's own command gives a run that started just now in this project. */
function claimCommand(surface: Kind, started: number): { label: string; toolUseId?: string } | undefined {
  const c = [...commands].reverse().find(x => !x.used && x.surface === surface && started >= x.at - 5_000 && started - x.at < 120_000)
  if (!c) return undefined
  c.used = true
  return { label: c.label, toolUseId: c.toolUseId }
}

/** Applies one file's new lines to the runs; reports the runs that just ended. */
function applyLines(runs: Run[], w: Watch, lines: readonly string[], now: number): { runs: Run[]; ended: Run[] } {
  const ended: Run[] = []
  const id = w.parent ?? w.id
  let i = runs.findIndex(r => r.id === id)
  if (i === -1) return { runs, ended }
  let next = [...runs]
  for (const l of lines) {
    const a = adapt(l, now)
    if (a.bad) {
      const at = next.findIndex(r => r.id === id)
      if (at >= 0 && !w.member) next[at] = { ...next[at]!, skipped: (next[at]!.skipped ?? 0) + 1 }
    }
    for (const ev of a.events) {
      const before = next[i]!
      const after = w.member ? foldMember(before, w.member, ev) : fold(before, ev)
      next[i] = after
      if (!w.member && ev.k === 'memberStart' && ev.logPath && !watches.has(ev.logPath)) {
        watches.set(ev.logPath, { id: ev.logPath, path: ev.logPath, bytes: 0, rest: '', done: false, member: ev.path, parent: id })
      }
      // A member that ended is read once more (its last lines may hold the failure), then left.
      if (!w.member && ev.k === 'memberEnd' && ev.logPath) {
        const m = watches.get(ev.logPath)
        if (m) m.closing = true
        else watches.set(ev.logPath, { id: ev.logPath, path: ev.logPath, bytes: 0, rest: '', done: false, member: ev.path, parent: id, closing: true })
      }
      if (terminal(before, ev)) {
        w.done = true
        ended.push(after)
      }
    }
  }
  i = next.findIndex(r => r.id === id)
  return { runs: next, ended }
}

function terminal(run: Run, ev: Ev): boolean {
  if (ev.k === 'suiteDone' || ev.k === 'mdDone') return true
  return ev.k === 'runEnd' && run.kind === 'run'
}

/** Once a second: new live runs from their pointers, new lines from every file still being followed. */
async function poll($: EngineInterface) {
  if (polling || !activeDir || !projectDir) return
  polling = true
  try {
    const now = await $.clock.now()
    let runs = await read($, runsAtom)
    let changed = false
    const ended: Run[] = []
    const listing = await $.fs.list(activeDir).catch(() => [])
    const present = new Set(listing.map(e => e.name))
    for (const e of listing) {
      if (!e.name.endsWith('.json') || seenPointers.has(e.name)) continue
      seenPointers.add(e.name)
      const p = parsePointer((await $.fs.read(`${activeDir}/${e.name}`).catch(() => '')) ?? '', now)
      if (!p || !inside(p.cwd, projectDir) || !(await alive($, p.pid))) continue
      runs = startWatch(runs, p, e.name, await processLabel($, p.pid))
      changed = true
    }
    // Members first, so a suite's end reads its members' last lines; a member a suite names now is read now too.
    const visited = new Set<Watch>()
    const pending = () => [...watches.values()].filter(w => !w.done && !visited.has(w)).sort((a, b) => Number(!a.member) - Number(!b.member))
    for (let w = pending()[0]; w; w = pending()[0]) {
      visited.add(w)
      const lines = await readNew($, w)
      if (lines.length) {
        const r = applyLines(runs, w, lines, now)
        runs = r.runs
        ended.push(...r.ended)
        changed = true
      }
      if (w.closing) w.done = true
      // A killed kane-cli leaves no terminal line: once its pointer is gone and its pid with it, the run is over.
      if (!w.done && !w.member && w.pointer && !present.has(w.pointer) && !(await alive($, w.pid))) {
        w.done = true
        runs = runs.map(r => (r.id === w.id && (r.status === 'running' || r.status === 'pending') ? { ...r, status: 'failed' as const, endedAt: now, failure: r.failure ?? { why: 'kane-cli exited before it reported a result' } } : r))
        const r = runs.find(x => x.id === w.id)
        if (r) ended.push(r)
        changed = true
      }
    }
    for (const [k, w] of watches) if (w.done) watches.delete(k)
    if (changed) await update($, runsAtom, () => runs)
    for (const r of ended) await finished($, r)
    for (const r of ended) seeking.set(r.id, now + 30_000)
    if (seeking.size) await seekEvidence($, now)
    if (runs.some(r => r.status === 'running' || r.status === 'pending')) await update($, tickAtom, n => n + 1)
  } finally {
    polling = false
  }
}

/** kane-cli seals a run's evidence pack as it exits: `<session dir>/evidence/<id>.evidence`, and a suite's in the project's store under its execution id. */
async function findEvidence($: EngineInterface, r: Run): Promise<string | undefined> {
  if (r.executionId && r.cwd) {
    const stored = `${r.cwd}/.testmuai/evidence/${r.executionId}.evidence`
    if (await $.fs.exists(stored).catch(() => false)) return stored
  }
  const dir = `${r.sessionDir}/evidence`
  const packs = (await $.fs.list(dir).catch(() => [])).filter(e => e.kind === 'file' && e.name.endsWith('.evidence'))
  return packs.length === 1 ? `${dir}/${packs[0]!.name}` : undefined
}

/** Looks for the pack of each run that just ended, for half a minute at most. */
async function seekEvidence($: EngineInterface, now: number) {
  const runs = await read($, runsAtom)
  const found = new Map<string, string>()
  for (const [id, until] of seeking) {
    const r = runs.find(x => x.id === id)
    const pack = r && !r.evidence ? await findEvidence($, r) : undefined
    if (pack) found.set(id, pack)
    if (pack || !r || r.evidence || now > until) seeking.delete(id)
  }
  if (found.size) await update($, runsAtom, list => list.map(r => (found.has(r.id) ? { ...r, evidence: found.get(r.id) } : r)))
}

/** Starts kane-cli's local evidence viewer for a pack and answers the link it prints; the viewer lives until the session ends. */
function startViewer($: EngineInterface, pack: string): Promise<string | undefined> {
  return new Promise(resolve => {
    let said = false
    const say = (url: string | undefined) => {
      if (said) return
      said = true
      resolve(url)
    }
    void $.clock.sleep(15_000).then(() => say(undefined), () => say(undefined))
    void (async () => {
      let text = ''
      try {
        for await (const piece of $.process.spawn({ argv: [...kane, 'evidence', 'serve', pack], cwd: projectDir })) {
          text = (text + piece.text).slice(-4000)
          const link = text.match(/viewer\s+(https?:\/\/\S+)/)
          if (link && !viewers.has(pack)) {
            viewers.set(pack, link[1]!)
            say(link[1])
          }
        }
      } catch {
        // the viewer could not start: the caller falls back
      }
      viewers.delete(pack)
      say(undefined)
    })()
  })
}

/** One click to a run's evidence: its pack in kane-cli's viewer, in the browser. Without a pack or a viewer, Claude is asked instead. */
async function openEvidence($: EngineInterface, id: string) {
  const all = await read($, runsAtom)
  const r = all.find(x => x.id === id) ?? leaves(all).find(x => x.id === id)
  const pack = r?.evidence
  const url = pack ? (viewers.get(pack) ?? (await startViewer($, pack))) : undefined
  if (url) {
    const opened = await $.process.run(['open', url], { timeoutMs: 5000 }).catch(() => undefined)
    if (opened?.exitCode !== 0) await $.process.run(['xdg-open', url], { timeoutMs: 5000 }).catch(() => undefined)
    $.ui.toast('Evidence opened in the browser')
    return
  }
  void $.prompt.submit({ text: `Open the evidence for the kane-cli run in ${pack ?? r?.sessionDir ?? id}.` }).catch(() => undefined)
}

/** A run nobody started in this chat is named from its own process: the command line kane-cli was started with. */
async function processLabel($: EngineInterface, pid: number): Promise<string | undefined> {
  const r = await $.process.run(['ps', '-o', 'args=', '-p', String(pid)], { timeoutMs: 3000 }).catch(() => undefined)
  return r?.exitCode === 0 ? labelFromCommand(r.stdout)?.label : undefined
}

function startWatch(runs: Run[], p: Pointer, pointer: string, fromProcess?: string): Run[] {
  const id = p.sessionDir
  const claimed = claimCommand(p.surface, p.started) ?? (fromProcess ? { label: fromProcess } : undefined)
  const run = newRun(id, p.surface, p.sessionDir, p.started, { pid: p.pid, cwd: p.cwd, ...(claimed ? { label: claimed.label, labelRank: RANK.command } : {}), ...(claimed?.toolUseId ? { toolUseId: claimed.toolUseId } : {}) })
  // A reload follows the file again from its start, replacing what the last module folded.
  watches.set(id, { id, path: `${p.sessionDir}/events.ndjson`, pointer, pid: p.pid, bytes: 0, rest: '', done: false })
  const keep = runs.find(r => r.id === id)
  const fresh = keep ? { ...run, toolUseId: run.toolUseId ?? keep.toolUseId, label: keep.labelRank && keep.labelRank >= RANK.command ? keep.label : run.label, labelRank: Math.max(keep.labelRank ?? 0, run.labelRank ?? 0) } : run
  return [...runs.filter(r => r.id !== id), fresh]
}

/** A run reached its end: remember it, refresh assurance, and clear a change it covered. */
async function finished($: EngineInterface, r: Run) {
  if (r.status !== 'passed' && r.status !== 'failed') return
  const entry = historyEntry(r)
  if (!entry) return
  await update($, lastAtom, () => entry)
  const all = await recent($)
  const list = [entry, ...(all[projectDir] ?? [])].slice(0, HISTORY_MAX)
  all[projectDir] = list
  await update($, historyAtom, () => list)
  await $.store.set(RECENT, all).catch(() => undefined)
  const change = await read($, changeAtom)
  if (change && r.startedAt > change.lastAt) {
    await update($, changeAtom, () => null)
    await update($, offerAtom, () => null)
  }
  await refreshAssurance($)
}

async function refreshAssurance($: EngineInterface) {
  if (!projectDir) return
  const has = await $.fs.exists(`${projectDir}/.context`).catch(() => false)
  if (!has) {
    await update($, assuranceAtom, () => ({ state: 'none' }) as Assurance)
    return
  }
  const r = await $.process.run([...kane, 'cover', 'gaps', '--json'], { cwd: projectDir, timeoutMs: 30_000 }).catch(() => undefined)
  if (!r) return
  if (r.exitCode !== 0 && /no context store/i.test(`${r.stderr}${r.stdout}`)) {
    await update($, assuranceAtom, () => ({ state: 'none' }) as Assurance)
    return
  }
  const a = parseCoverGaps(r.stdout)
  if (a.state === 'ready') await update($, assuranceAtom, () => a)
}

/** The last results per project. Its own key: v1 of this plugin kept a list under `history` in the same store. */
const RECENT = 'recentByProject'

async function recent($: EngineInterface): Promise<Record<string, HistoryEntry[]>> {
  const v = await $.store.get(RECENT).catch(() => undefined)
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, HistoryEntry[]>) : {}
}

async function readTheme($: EngineInterface) {
  const row = (await $.config.list()).find(r => r.key === 'theme')
  usePalette(row?.value)
  await update($, tickAtom, n => n + 1)
}

async function loadLast($: EngineInterface) {
  const list = (await recent($))[projectDir] ?? []
  if (list.length) await update($, historyAtom, () => list)
  const last = list[0]
  if (last) await update($, lastAtom, () => last)
}

// ── after Claude changes code ────────────────────────────────────────────

async function ignored($: EngineInterface, path: string): Promise<boolean> {
  const r = await $.process.run(['git', 'check-ignore', '-q', path], { cwd: projectDir, timeoutMs: 3000 }).catch(() => undefined)
  return r?.exitCode === 0
}

async function noteEdit($: EngineInterface, path: string) {
  if (!path || !inside(path, projectDir) || !isTrackedEdit(path.slice(projectDir.length + 1)) || (await ignored($, path))) return
  const now = await $.clock.now()
  await update($, changeAtom, c => (c ? { ...c, files: c.files.includes(path) ? c.files : [...c.files, path], lastAt: now } : { files: [path], firstAt: now, lastAt: now, shown: false }))
}

/** The files a Bash command changed, as Claude Code reports them beside its output. */
function bashChanges(result: unknown): string[] {
  const diff = (result as { bashEditDiff?: { changedFiles?: unknown; files?: unknown } } | undefined)?.bashEditDiff
  if (!diff) return []
  if (Array.isArray(diff.changedFiles)) return diff.changedFiles.filter((f): f is string => typeof f === 'string')
  return Array.isArray(diff.files) ? diff.files.map(f => (f as { filePath?: unknown }).filePath).filter((f): f is string => typeof f === 'string') : []
}

async function savedTests($: EngineInterface): Promise<{ name: string; text: string }[]> {
  const dir = `${projectDir}/.testmuai/tests`
  const list = await $.fs.list(dir).catch(() => [])
  const out: { name: string; text: string }[] = []
  for (const e of list.filter(x => x.name.endsWith('_test.md')).slice(0, 40)) {
    out.push({ name: e.name, text: (await $.fs.read(`${dir}/${e.name}`).catch(() => '')) ?? '' })
  }
  return out
}

async function openOffer($: EngineInterface) {
  const change = await read($, changeAtom)
  if (!change) return
  const files = change.files
  await update($, viewAtom, v => ({ ...v, tab: 'runs' as const, open: 'offer' }))
  await openPane($)
  const tests = await savedTests($)
  const history = (await recent($))[projectDir] ?? []
  const last: Record<string, HistoryEntry> = {}
  for (const t of tests) {
    const hit = history.find(h => h.label === t.name || h.label.endsWith(`/${t.name}`))
    if (hit) last[t.name] = hit
  }
  const saved = savedTestsFor(files, tests, last)
  await update($, offerAtom, () => ({ files, drafting: false, saved, url: startUrl(tests), last }))
  // A saved test that covers the change comes first; Claude drafts a new objective only when none does.
  if (saved.length === 0) await draftObjective($)
}

/** Claude writes the objective from the changed paths and their diff. */
async function draftObjective($: EngineInterface) {
  const o = await read($, offerAtom)
  if (!o) return
  await update($, offerAtom, x => (x ? { ...x, drafting: true, note: undefined } : x))
  const rel = o.files.map(f => (f.startsWith(`${projectDir}/`) ? f.slice(projectDir.length + 1) : f))
  const d = await $.process.run(['git', 'diff', '--', ...rel], { cwd: projectDir, timeoutMs: 10_000 }).catch(() => undefined)
  const diff = (d?.stdout ?? '').slice(0, 8000)
  const reply = await $.model.fork({ prompt: draftPrompt(rel, diff) }).catch(() => undefined)
  const objective = reply?.isAnswered ? objectiveFrom(reply.text) : ''
  await update($, offerAtom, x => (x ? { ...x, drafting: false, objective: objective || undefined, note: objective ? undefined : `No draft: ${reply && !reply.isAnswered ? reply.reason : 'Claude did not answer'}.` } : x))
}

function autoInstruction(files: readonly string[], saved: readonly string[], url?: string): string {
  const rel = files.map(f => (f.startsWith(`${projectDir}/`) ? f.slice(projectDir.length + 1) : f))
  const reuse = saved.length ? ` A saved test may already cover it: ${saved.slice(0, 3).map(s => `.testmuai/tests/${s}`).join(', ')} (kane-cli testmd run <file>${url ? ` --url ${url}` : ''} --agent --headless).` : ''
  const start = url ? ` --url ${url}` : ' --url <the app\'s start page>'
  return `kane-qe: you changed ${rel.join(', ')} and no kane-cli run has tested it yet. Before you finish, test the change in a browser with kane-cli (kane-cli run "<what a user does and what must be true>"${start} --agent --headless).${reuse} Then report the result.`
}

/** A kane-cli command Claude is about to run names the run it starts. */
async function beforeTool($: EngineInterface, e: { tool: string; command?: unknown; tool_use_id?: string }) {
  if (e.tool !== 'Bash') return
  const named = labelFromCommand(String(e.command ?? ''))
  if (!named) return
  commands.push({ ...named, at: await $.clock.now(), used: false, toolUseId: e.tool_use_id })
  if (commands.length > 20) commands.shift()
}

/** Files Claude changed, by the edit tools or from the shell (the Bash result lists what it changed). */
async function afterTool($: EngineInterface, e: { tool: string }, result: { deny?: unknown; isError?: unknown; result?: unknown }) {
  if (result.deny || result.isError) return
  if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
    const input = e as unknown as { file_path?: unknown; notebook_path?: unknown }
    await noteEdit($, String(input.file_path ?? input.notebook_path ?? ''))
  }
  // A Bash result lists every file that changed while it ran, whoever wrote it: a kane-cli run takes long enough
  // for other tools to write theirs, so its list is not Claude's edits.
  if (e.tool === 'Bash' && !labelFromCommand(String((e as { command?: unknown }).command ?? ''))) {
    for (const path of bashChanges(result.result)) await noteEdit($, path)
  }
}

/** At the end of a turn: the reason to hold Claude (auto mode), or nothing; in offer mode the band's warning shows. */
async function holdForChange($: EngineInterface, e: { stop_hook_active?: boolean }): Promise<string | undefined> {
  const change = await read($, changeAtom)
  const mode = modeOf(await read($, modeAtom))
  if (!change || mode === 'off') return undefined
  if (mode === 'offer') {
    if (!change.shown) await update($, changeAtom, c => (c ? { ...c, shown: true } : c))
    return undefined
  }
  // Held once already and the turn still ends untested: the band offers the test instead.
  if (e.stop_hook_active || change.heldAt === change.lastAt) {
    if (!change.shown) await update($, changeAtom, c => (c ? { ...c, shown: true } : c))
    return undefined
  }
  await update($, changeAtom, c => (c ? { ...c, heldAt: c.lastAt } : c))
  const tests = await savedTests($).catch(() => [])
  return autoInstruction(change.files, savedTestsFor(change.files, tests), startUrl(tests))
}

async function themeChanged($: EngineInterface, theme: unknown) {
  usePalette(theme)
  await update($, tickAtom, n => n + 1)
}

// ── actions ──────────────────────────────────────────────────────────────

async function act($: EngineInterface, a: string) {
  const at = a.indexOf(':')
  const k = at < 0 ? a : a.slice(0, at)
  const arg = at < 0 ? '' : a.slice(at + 1)
  if (k === 'open') await openPane($)
  else if (k === 'tab') {
    await update($, viewAtom, v => ({ ...v, tab: arg === 'assure' ? ('assure' as const) : arg === 'history' ? ('history' as const) : ('runs' as const), open: '', uc: '' }))
    await openPane($)
  } else if (k === 'uc') await update($, viewAtom, v => ({ ...v, tab: 'assure' as const, uc: arg }))
  else if (k === 'uc-back') await update($, viewAtom, v => ({ ...v, uc: '' }))
  else if (k === 'uc-close') {
    const a = await read($, assuranceAtom)
    const u = a.state === 'ready' ? a.useCases.find(x => x.id === arg) : undefined
    if (u) void $.prompt.submit({ text: gapsPrompt(u) }).catch(() => undefined)
  } else if (k === 'run') await update($, viewAtom, v => ({ ...v, open: arg, tab: 'runs' as const }))
  else if (k === 'back') await update($, viewAtom, v => ({ ...v, open: '' }))
  else if (k === 'offer') await openOffer($)
  else if (k === 'offer-draft') await draftObjective($)
  else if (k === 'offer-run') {
    const o = await read($, offerAtom)
    if (!o?.objective) return
    await update($, viewAtom, v => ({ ...v, open: '' }))
    await update($, offerAtom, () => null)
    const url = o.url ? ` --url ${o.url}` : ''
    const hint = o.url ? '' : ' kane-cli needs a start page: pass --url with this app\'s URL unless `kane-cli config show` has a default_url.'
    void $.prompt.submit({ text: `Test my last change with kane-cli: kane-cli run "${o.objective.replace(/"/g, "'")}"${url} --agent --headless.${hint} Then report the result.` }).catch(() => undefined)
  } else if (k === 'saved') {
    const o = await read($, offerAtom)
    await update($, viewAtom, v => ({ ...v, open: '' }))
    await update($, offerAtom, () => null)
    const url = o?.url ? ` --url ${o.url}` : ''
    void $.prompt.submit({ text: `Test my last change with the saved kane-cli test: kane-cli testmd run .testmuai/tests/${arg}${url} --agent --headless. Then report the result.` }).catch(() => undefined)
  } else if (k === 'offer-skip') {
    await update($, offerAtom, () => null)
    await update($, changeAtom, c => (c ? { ...c, shown: false } : c))
    await update($, viewAtom, v => ({ ...v, open: '' }))
  } else if (k === 'evidence') await openEvidence($, arg)
  else if (k === 'steps') {
    await update($, viewAtom, v => ({ ...v, tab: 'runs' as const, open: arg, uc: '' }))
    await openPane($)
  } else if (k === 'setup') {
    void $.prompt.submit({
      text: 'Set up kane-cli assurance for this project: ask me for the requirement (a PRD file, a Jira, Confluence or Linear link, or a web page), ingest it with kane-cli, extract the use cases and design tests (use --mode agent), then show me the coverage with kane-cli cover gaps.',
    }).catch(() => undefined)
  }
}

// ── the mascot's animation ───────────────────────────────────────────────

/** Where the mascot is an image, step its frame by redrawing the sites that show it. */
async function pulse($: EngineInterface) {
  if (!thinking || !remote) return
  frame += 1
  await update($, tickAtom, n => n + 1)
}

function paint($: EngineInterface) {
  if (!thinking || sites.size === 0) return
  if (!remote) frame += 1
  const cells = rasterCells(pixelFrame(poseAt(true, frame)))
  for (const requestId of sites) void $.ui.blit({ requestId, key: 'mascot', cells }).catch(() => sites.delete(requestId))
}

// ── the mod ──────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const o = options as Record<string, unknown>
  setting = o.afterChange === 'auto' || o.afterChange === 'off' ? o.afterChange : 'offer'
  kane = String(o.kaneCommand ?? 'kane-cli').trim().split(/\s+/).filter(Boolean)
  if (kane.length === 0) kane = ['kane-cli']

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    projectDir = String((e as { cwd?: unknown }).cwd ?? '').replace(/\/$/, '')
    const home = await $.env.get('HOME').catch(() => undefined)
    if (home) activeDir = `${home}/.testmuai/kaneai/sessions/active`
    await $.command.register({ name: 'kane', description: 'Kane: open the runs pane; /kane assurance; /kane history; /kane auto | ask | off for changes', argumentHint: '[assurance | history | auto | ask | off]' })
    $.clock.every(1000, () => void poll($).catch(() => undefined))
    $.clock.every(STEP_MS, () => paint($))
    $.clock.every(STEP_MS, () => void pulse($).catch(() => undefined))
    void loadLast($).catch(() => undefined)
    void refreshAssurance($).catch(() => undefined)
    void readTheme($).catch(() => undefined)
    return started
  })

  // The palette follows Claude Code's theme: the design's colours are for dark backgrounds.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (!result.deny) await themeChanged($, e.value).catch(() => undefined)
    return result
  })

  on('command.run', { command: 'kane' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === '' || arg === 'runs') {
      await act($, 'tab:runs')
      return { text: 'Kane pane opened. It follows every kane-cli run in this folder by itself.' }
    }
    if (arg === 'assurance' || arg === 'assure') {
      await refreshAssurance($)
      await act($, 'tab:assure')
      return { text: 'Kane: assurance for this project.' }
    }
    if (arg === 'history') {
      await act($, 'tab:history')
      return { text: 'Kane: finished runs in this project.' }
    }
    if (arg === 'auto' || arg === 'ask' || arg === 'off') {
      const mode: AfterChange = arg === 'ask' ? 'offer' : arg
      await update($, modeAtom, () => mode)
      return { text: `Kane: after Claude changes code, ${mode === 'auto' ? 'Claude tests it before it finishes' : mode === 'offer' ? 'the band offers to test it' : 'nothing happens'} (this session).` }
    }
    return { text: 'Kane: /kane opens the pane · /kane assurance · /kane history · /kane auto | ask | off sets what happens after Claude changes code.' }
  })

  // These three sit in the path of what the person and Claude do: the mod's own work is caught, the action always goes on.
  on('tool.call', async ($, e, next) => {
    await beforeTool($, e).catch(() => undefined)
    const result = await next(e)
    await afterTool($, e, result).catch(() => undefined)
    return result
  })

  // The turn is ending: an untested change is offered (offer), or Claude is held once to test it (auto).
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (result.block) return result
    const block = await holdForChange($, e).catch(() => undefined)
    return block ? { ...result, block } : result
  })

  // A kane-cli run Claude started is drawn as a card in the chat, in place of its shell row.
  // The chat folds shell calls into one count line: a group holding a run is unfolded, so its row is drawn.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded || !e.props.calls.some(c => c.tool === 'Bash' && isRunCommand(String((c.input as { command?: unknown } | undefined)?.command ?? '')))) return next(e)
    return next({ ...e, props: { ...e.props, isExpanded: true } })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== 'Bash' || !isRunCommand(String((e.props.input as { command?: unknown } | undefined)?.command ?? ''))) return next(e)
    const r = (await read($, runsAtom)).find(x => x.toolUseId === e.props.tool_use_id)
    // No run came of the command (kane-cli refused or failed to start): its own row says why.
    if (!r) return next(e)
    await read($, tickAtom)
    const press: Press = a => void act($, a).catch(() => undefined)
    // Printed text takes no clicks: only the desktop and the fullscreen terminal draw buttons.
    const clickable = e.surface !== 'terminal' || e.viewport?.isFullscreen === true
    return chatCard($.ui.resolve(e), e.surface, press, r, await $.clock.now(), e.viewport?.columns ?? 90, clickable)
  })

  // The card stands for the whole call: once the run has a result, kane-cli's raw output is not drawn beneath it.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.props.tool !== 'Bash') return next(e)
    const r = (await read($, runsAtom)).find(x => x.toolUseId === e.props.tool_use_id)
    if (!r || (r.status !== 'passed' && r.status !== 'failed')) return next(e)
    const ui: Kit = $.ui.resolve(e)
    return <ui.Box />
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const runs = await read($, runsAtom)
    await read($, tickAtom)
    const change = await read($, changeAtom)
    const mode = modeOf(await read($, modeAtom))
    const now = await $.clock.now()
    // Auto promises Claude will test it until a held stop has been spent on this change; then the button.
    const promised = mode === 'auto' && change?.heldAt !== change?.lastAt
    const shownChange = change && mode !== 'off' && (promised || change.shown) ? { files: change.files.length, mode: promised ? ('auto' as const) : ('offer' as const) } : undefined
    const model = band(runs, { assurance: await read($, assuranceAtom), change: shownChange, last: await read($, lastAtom), now, columns: e.props.bodyColumns - RASTER.columns - 1 })
    thinking = model.think
    const table = $.ui.resolve(e)
    if (e.surface === 'terminal') sites.add(e.requestId)
    else remote = true
    const press: Press = a => void act($, a).catch(() => undefined)
    return (
      <table.Box flexDirection="row" gap={1}>
        {mascot(table, e.surface, model.think, frame)}
        <table.Box flexDirection="column">{model.rows.map(r => line(table, press, r))}</table.Box>
      </table.Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await read($, viewAtom)
    await read($, tickAtom)
    const runs = await read($, runsAtom)
    const now = await $.clock.now()
    const all = leaves(runs)
    // The header counts each test once, by its latest result, as the band does; the list below keeps every run.
    const c = tally(all.some(r => r.status === 'running' || r.status === 'pending') ? all : latest(all))
    const width = Math.max(30, e.props.bodyColumns - 2)
    const table = $.ui.resolve(e)
    const ui: Kit = table
    if (e.surface === 'terminal') sites.add(e.requestId)
    else remote = true
    const press: Press = a => void act($, a).catch(() => undefined)
    const opened = all.find(r => r.id === v.open) ?? runs.find(r => r.id === v.open)
    let body
    if (v.tab === 'assure') body = assureView(ui, press, await read($, assuranceAtom), now, v.uc)
    else if (v.tab === 'history') body = historyView(ui, await read($, historyAtom), now, width)
    else if (v.open === 'offer') body = offerView(ui, press, await read($, offerAtom), await read($, changeAtom), now, width)
    else if (opened?.kind === 'testrun' && opened.members) body = suiteView(ui, press, opened, now, width, true)
    else if (opened) body = runDetail(ui, press, opened, now, width)
    else body = runsView(ui, press, runs, now, width, await read($, lastAtom))
    return (
      <ui.Box flexDirection="column">
        <ui.Box flexDirection="row" gap={1}>
          {mascot(table, e.surface, c.running > 0, frame)}
          <ui.Box flexDirection="column">
            <ui.Text color={C.purple} bold>
              kane
            </ui.Text>
            <ui.Text dimColor>{c.running > 0 ? `${c.running} running` : c.total > 0 ? `${c.passed} passed · ${c.failed} failed` : 'idle'}</ui.Text>
            <ui.Box flexDirection="row" gap={1}>
              <ui.Button key="tab-runs" label="Runs" variant={v.tab === 'runs' ? 'primary' : 'secondary'} onPress={() => press('tab:runs')} />
              <ui.Button key="tab-assure" label="Assurance" variant={v.tab === 'assure' ? 'primary' : 'secondary'} onPress={() => press('tab:assure')} />
              <ui.Button key="tab-history" label="History" variant={v.tab === 'history' ? 'primary' : 'secondary'} onPress={() => press('tab:history')} />
            </ui.Box>
          </ui.Box>
        </ui.Box>
        <ui.Text> </ui.Text>
        {body}
      </ui.Box>
    )
  })
}
