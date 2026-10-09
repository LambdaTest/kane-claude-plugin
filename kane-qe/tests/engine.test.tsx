import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const T0 = Date.parse('2026-10-08T10:00:00.000Z')
const HOME = '/home/qa'
const ACTIVE = `${HOME}/.testmuai/kaneai/sessions/active`
// A project under a tool folder (~/.claude/jobs/…) must still have its edits tracked.
const PROJECT = '/home/qa/.claude/jobs/1/shop'
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const line = (o: object, s = 0) => `${JSON.stringify({ ...o, v: 1, ts: at(s) })}\n`
const OK = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: exitCode ? stdout : '', isStdoutTruncated: false, isStderrTruncated: false } })

const BAND = {
  plugin: 'kane-qe',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

const PANE = {
  plugin: 'kane-qe',
  component: 'Pane',
  requestId: 'kane-qe',
  props: { title: 'Kane', isFocused: false, bodyColumns: 56, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

type World = { files: Record<string, string>; alive: Set<number>; prompts: string[]; ran: string[][]; rows: { component: string; isExpanded?: boolean }[]; viewer?: string; cover?: string; forkText?: string; ignored: Set<string>; bashResult?: unknown; store?: Record<string, unknown>; ps?: Record<number, string> }

/** The engine beneath the plugin: a fake disk, processes, and the calls the mod makes. */
function world(on: On, w: Partial<World> = {}): World & { clock: ReturnType<typeof mock.clock> } {
  const state: World = { files: {}, alive: new Set(), prompts: [], ran: [], rows: [], ignored: new Set(), ...w }
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, state.store)
  mock.env(on, { HOME })
  on('session.start', ($, e) => ({ cwd: e.cwd }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.blit', () => ({ value: {} }) as never)
  on('prompt.submit', ($, e) => {
    state.prompts.push(String((e as { text?: unknown }).text))
    return { text: String((e as { text?: unknown }).text) } as never
  })
  on('model.fork', () => ({ value: state.forkText ? { isAnswered: true, text: state.forkText } : { isAnswered: false, reason: 'nothing-to-fork' } }) as never)
  on('fs.exists', ($, e) => ({ value: e.path in state.files || Object.keys(state.files).some(f => f.startsWith(`${e.path}/`)) }) as never)
  on('fs.list', ($, e) => {
    const dir = `${e.path.replace(/\/$/, '')}/`
    const names = Object.keys(state.files).filter(f => f.startsWith(dir) && !f.slice(dir.length).includes('/'))
    return { value: names.map(f => ({ name: f.slice(dir.length), kind: 'file', size: state.files[f]!.length, mtimeMs: 0, isLink: false })) } as never
  })
  on('fs.read', ($, e) => (e.path in state.files ? { value: state.files[e.path] } : { deny: 'ENOENT' }) as never)
  on('fs.stat', ($, e) => (e.path in state.files ? { value: { kind: 'file', size: state.files[e.path]!.length, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' }) as never)
  on('process.run', ($, e) => {
    const argv = e.argv
    state.ran.push([...argv])
    if (argv[0] === 'open') return OK('') as never
    if (argv[0] === 'ps') return (state.ps?.[Number(argv[4])] ? OK(`${state.ps[Number(argv[4])]}\n`) : OK('', 1)) as never
    if (argv[0] === 'kill') return OK('', state.alive.has(Number(argv[2])) ? 0 : 1) as never
    if (argv[0] === 'git' && argv[1] === 'check-ignore') return OK('', state.ignored.has(String(argv[3])) ? 0 : 1) as never
    if (argv[0] === 'git' && argv[1] === 'diff') return OK('+ postcode.trim()') as never
    if (argv.includes('cover')) return (state.cover ? OK(state.cover) : OK('error: no context store here', 1)) as never
    return OK('', 1) as never
  })
  on('tool.call', ($, e) => ({ result: (e as { tool?: string }).tool === 'Bash' && state.bashResult ? state.bashResult : { ok: true } }) as never)
  on('classic.Stop', () => ({}) as never)
  // kane-cli's evidence viewer: it prints its link and keeps serving.
  on('process.spawn', async function* ($: unknown, e: { argv: readonly string[] }) {
    state.ran.push([...e.argv])
    if (state.viewer) yield { stream: 'stdout', text: `serving 1 pack on http://127.0.0.1:5173\npack.evidence\n  pack    http://127.0.0.1:5173/t/p\n  viewer  ${state.viewer}\npress Ctrl-C to stop\n` } as never
    // A viewer that started keeps serving; one that could not start exits.
    if (state.viewer) await new Promise(() => undefined)
    return { value: { code: 2, signal: null } } as never
  } as never)
  on('ui.toast', () => ({ value: {} }) as never)
  // The engine's own row, where the mod leaves a row alone.
  on('ui.render', ($, e) => {
    state.rows.push({ component: e.component, isExpanded: (e.props as { isExpanded?: boolean }).isExpanded })
    const { Text } = $.ui.resolve(e)
    return (<Text>{`engine ${e.component}`}</Text>) as never
  })
  return Object.assign(state, { clock })
}

/** kane-cli starts a run: its pointer and its first lines. */
function startRun(w: World, pid: number, dir: string, surface: string, lines: string, cwd = PROJECT) {
  w.alive.add(pid)
  w.files[`${ACTIVE}/${pid}.json`] = JSON.stringify({ pid, cwd, surface, session_dir: dir, started: at(0), cli_version: '0.8.20', host_agent: 'claude-code' })
  w.files[`${dir}/events.ndjson`] = lines
}

/** kane-cli exits: the pointer goes and the process with it. */
function endRun(w: World, pid: number) {
  delete w.files[`${ACTIVE}/${pid}.json`]
  w.alive.delete(pid)
}

const S = `${HOME}/.testmuai/kaneai/sessions`

describe('drawing', () => {
  test('the band draws on the terminal and the desktop: mascot, idle, assurance, Open', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await w.clock.settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface } as never)
      expect(await ui.find({ type: 'Text', text: /idle/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /assurance/ })).toBeDefined()
      expect(await ui.find({ key: 'open' })).toBeDefined()
      expect(await ui.find({ type: surface === 'terminal' ? 'Raster' : 'Svg' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('colours follow Claude Code’s theme: the design’s palette on dark, a darker one on light', async ($, on) => {
    const w = world(on)
    on('config.list', () => ({ value: [{ key: 'theme', value: 'light' }] }) as never)
    on('config.set', ($, e) => ({ value: (e as { value: unknown }).value }) as never)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    const assurance = async () => (await band.find({ type: 'Text', text: /^assurance$/ }))?.props.color
    expect(await assurance()).toBe('#9a7200')
    await $.config.set({ key: 'theme', value: 'dark' } as never)
    await w.clock.settle()
    expect(await assurance()).toBe('#ffd66b')
    await band.unmount()
  })

  test('a pane hidden behind another one in the dock is brought to the front when the person opens it', async ($, on) => {
    const w = world(on)
    const closed: string[] = []
    on('ui.panes', () => ({ value: [{ id: 'kane-qe', title: 'Kane', isShown: false, isFocused: false, isPlaced: true }] }) as never)
    on('ui.close', ($, e) => {
      closed.push((e as { id: string }).id)
      return { value: undefined } as never
    })
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await w.clock.settle()
    await $.command.run({ command: 'kane', args: '' } as never)
    expect(closed).toEqual(['kane-qe'])
  })

  test('the pane has Runs and Assurance; with no assurance it offers to set it up with Claude', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await w.clock.settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ ...PANE, surface } as never)
      expect(await pane.find({ type: 'Text', text: /No kane-cli run in this session yet/ })).toBeDefined()
      await pane.press({ key: 'tab-assure' })
      expect(await pane.find({ type: 'Text', text: /Assurance is not set up/ })).toBeDefined()
      await pane.press({ key: 'setup' })
      await pane.press({ key: 'tab-runs' })
      await pane.unmount()
    }
    expect(w.prompts[0]).toContain('Set up kane-cli assurance')
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /not set up/ })).toBeDefined()
    expect(await band.find({ key: 'setup' })).toBeDefined()
    await band.unmount()
  })
})

describe('watching kane-cli', () => {
  test('a testmd run Claude starts shows within two seconds, steps and all, then ends as a failed run', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    // Claude runs it: the command names the run.
    await $.tool.call({ tool: 'Bash', command: 'kane-cli testmd run .testmuai/tests/checkout_guest_test.md --agent --headless' } as never)
    const dir = `${S}/run-1`
    startRun(w, 501, dir, 'testmd', line({ type: 'test_md_step_start', step_index: 1, heading: 'Open the cart' }, 1))
    await w.clock.advance(2000)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /running/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /checkout_guest/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Open the cart/ })).toBeDefined()

    w.files[`${dir}/events.ndjson`] +=
      line({ type: 'test_md_step_end', step_index: 1, status: 'passed', duration_s: 5 }, 6) +
      line({ type: 'test_md_step_start', step_index: 2, heading: 'Fill the shipping address' }, 6) +
      line({ type: 'step_event', index: 1, event: 'reasoning', detail: 'the postcode field is empty' }, 7) +
      line({ type: 'step_event', index: 1, event: 'action', detail: 'Typing the postcode', action_type: 'type' }, 8) +
      line({ type: 'step_event', index: 1, event: 'assertion', detail: 'the page shows "Enter a valid postcode"', passed: false }, 9) +
      line({ type: 'run_end', status: 'failed', credits_consumed: 31.2, verdict: { root_cause: 'Postcode field rejects valid input', category: 'functional_defect', severity: 'high', confidence: 0.86 } }, 10) +
      line({ type: 'test_md_step_end', step_index: 2, status: 'failed', duration_s: 4 }, 10) +
      line({ type: 'test_md_done', overall_status: 'failed', duration_s: 10 }, 10)
    endRun(w, 501)
    await w.clock.advance(2000)
    await w.clock.settle()
    expect(await band.find({ type: 'Text', text: /1 failed/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /failed on/ })).toBeDefined()

    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    await pane.press({ key: `run-${dir}` })
    expect(await pane.find({ type: 'Text', text: /Postcode field rejects valid input/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /functional defect · high · 86% sure/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /✗ the page shows/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /31.2 credits/ })).toBeDefined()
    await pane.press({ key: 'evidence' })
    expect(w.prompts.at(-1)).toBe(`Open the evidence for the kane-cli run in ${dir}.`)
    await pane.unmount()
    await band.unmount()
  })

  test('three runs at once become cells; a suite counts its members from their own streams', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    for (const pid of [11, 12, 13]) startRun(w, pid, `${S}/r${pid}`, 'run', line({ type: 'stream_start', surface: 'run', pid }) + line({ step: 1, status: 'running', remark: 'Step 1' }))
    await w.clock.advance(1500)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /3 runs/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /3 running/ })).toBeDefined()
    for (const pid of [11, 12, 13]) {
      w.files[`${S}/r${pid}/events.ndjson`] += line({ type: 'run_end', status: 'passed', credits_consumed: 5 }, 9)
      endRun(w, pid)
    }
    await w.clock.advance(1500)
    await w.clock.settle()
    expect(await band.find({ type: 'Text', text: /✓ 3 passed/ })).toBeDefined()

    const sdir = `${S}/testrun-1`
    const a = `${PROJECT}/.testmuai/tests/login_test.md`
    const b = `${PROJECT}/.testmuai/tests/search_test.md`
    startRun(
      w,
      20,
      sdir,
      'testrun',
      line({ type: 'stream_start', surface: 'testrun', pid: 20 }) +
        line({ type: 'testrun_plan', members: [{ path: a }, { path: b }], parallel: 1 }) +
        line({ type: 'testrun_member_start', path: a, log_path: `${S}/m1/events.ndjson` }, 1) +
        line({ type: 'testrun_progress', running: ['.testmuai/tests/login_test.md'], pending: 1, done: 0, total: 2 }, 1),
    )
    w.files[`${S}/m1/events.ndjson`] = line({ type: 'test_md_step_start', step_index: 1, heading: 'Sign in as the test user' }, 2)
    await w.clock.advance(1500)
    await w.clock.settle()
    expect(await band.find({ type: 'Text', text: /0 of 2 tests done/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /login/ })).toBeDefined()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    await pane.press({ key: `run-${sdir}` })
    expect(await pane.find({ type: 'Text', text: /Sign in as the/ })).toBeDefined()
    expect(await pane.find({ key: 'run-' + a })).toBeDefined()
    await pane.unmount()
    await band.unmount()
  })

  test('a suite sent to the remote grid says where it is until the job reports, then counts its tests', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    const sdir = `${S}/testrun-remote-j42`
    const a = `${PROJECT}/.testmuai/tests/login_test.md`
    const b = `${PROJECT}/.testmuai/tests/search_test.md`
    startRun(
      w,
      50,
      sdir,
      'testrun',
      line({ type: 'stream_start', surface: 'testrun', pid: 50 }) +
        line({ type: 'testrun_plan', members: [{ path: a }, { path: b }], parallel: 2 }) +
        line({ type: 'remote_start', backend: 'hyperexecute', env: 'prod', log_path: `${sdir}/hyper.log` }, 1) +
        line({ type: 'remote_dispatched', job_id: 'j-42', job_url: 'https://grid.example/jobs/j-42' }, 3),
    )
    await w.clock.advance(1500)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /2 tests on the grid/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /each test is reported when the job ends/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /tests done/ })).toBeUndefined()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await pane.find({ type: 'Text', text: /hyperexecute · job j-42/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /https:\/\/grid\.example\/jobs\/j-42/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /The grid reports each test when the job ends/ })).toBeDefined()

    // The job ends: the grid's results arrive after the fact, stamped with the grid's own time.
    w.files[`${sdir}/events.ndjson`] +=
      line({ type: 'testrun_member_start', path: a, post_hoc: true }, 10) +
      line({ type: 'testrun_member_end', path: a, status: 'passed', duration_s: 20, post_hoc: true }, 30) +
      line({ type: 'testrun_member_start', path: b, post_hoc: true }, 10) +
      line({ type: 'testrun_member_end', path: b, status: 'failed', duration_s: 25, failure: { message: 'No results for the query' }, post_hoc: true }, 35) +
      line({ type: 'testrun_done', overall_status: 'failed' }, 120) +
      line({ type: 'remote_done', status: 'failed', exit: 1, job_id: 'j-42' }, 120)
    endRun(w, 50)
    await w.clock.advance(1500)
    await w.clock.settle()
    expect(await band.find({ type: 'Text', text: /✓ 1 passed/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /✗ 1 failed/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /The grid reports each test when the job ends/ })).toBeUndefined()
    expect(await pane.find({ type: 'Text', text: /hyperexecute · job j-42/ })).toBeDefined()
    await pane.unmount()
    await band.unmount()
  })

  test('History lists the finished runs kept for this project, and a run that ends joins them', async ($, on) => {
    const w = world(on, {
      store: {
        recentByProject: {
          [PROJECT]: [
            { label: 'checkout_guest_test.md', status: 'failed', at: T0 - 3_600_000, where: 'Fill the shipping address', kind: 'testmd', seconds: 66 },
            { label: 'login_test.md', status: 'passed', at: T0 - 7_200_000 },
          ],
          '/work/other-project': [{ label: 'theirs_test.md', status: 'passed', at: T0 - 60_000 }],
        },
      },
    })
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await w.clock.settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ ...PANE, surface } as never)
      await pane.press({ key: 'tab-history' })
      expect(await pane.find({ type: 'Text', text: /last 2 runs here · 1 passed · 1 failed/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /^checkout_guest$/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /testmd · failed on Fill the shipping address · 1m 06s/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /^login$/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /theirs/ })).toBeUndefined()
      await pane.press({ key: 'tab-runs' })
      await pane.unmount()
    }
    startRun(w, 61, `${S}/h1`, 'run', line({ type: 'stream_start', surface: 'run', pid: 61 }) + line({ step: 1, status: 'done', remark: 'Search for iPod' }, 4) + line({ type: 'run_end', status: 'passed', credits_consumed: 5 }, 9))
    await w.clock.advance(1500)
    await w.clock.settle()
    endRun(w, 61)
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect((await $.command.run({ command: 'kane', args: 'history' } as never) as { text?: string }).text).toContain('finished runs')
    expect(await pane.find({ type: 'Text', text: /last 3 runs here · 2 passed · 1 failed/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^Search for iPod$/ })).toBeDefined()
    await pane.unmount()
  })

  test('History with nothing kept says so', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await w.clock.settle()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    await pane.press({ key: 'tab-history' })
    expect(await pane.find({ type: 'Text', text: /No finished kane-cli run seen in this project yet/ })).toBeDefined()
    await pane.unmount()
  })

  test('a test file started outside the chat is named from its own process', async ($, on) => {
    const w = world(on, { ps: { 91: '/opt/kane/bin/node /opt/kane/kane-cli/dist/index.js testmd run .testmuai/tests/empty_cart_test.md --agent --headless' } })
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    startRun(w, 91, `${S}/o1`, 'testmd', line({ type: 'stream_start', surface: 'testmd', pid: 91 }) + line({ type: 'test_md_step_start', step_index: 1, heading: 'Step 1' }, 1) + line({ type: 'run_start', objective: 'At the shop, open the cart page and assert it is empty' }, 1))
    startRun(w, 92, `${S}/o2`, 'testmd', line({ type: 'stream_start', surface: 'testmd', pid: 92 }) + line({ type: 'run_start', objective: 'Sign in as the test user' }, 1))
    await w.clock.advance(1500)
    await w.clock.settle()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await pane.find({ key: `run-${S}/o1`, type: 'Button' })).toBeDefined()
    expect((await pane.find({ key: `run-${S}/o1` }))?.props.label).toBe('empty_cart_test.md')
    // With no process to read, the objective names it, as before.
    expect((await pane.find({ key: `run-${S}/o2` }))?.props.label).toBe('Sign in as the test user')
    await pane.unmount()
  })

  test('a stale pointer and another project’s run are not shown', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    startRun(w, 31, `${S}/x1`, 'run', line({ step: 1, status: 'running', remark: 'Step 1' }))
    w.alive.delete(31)
    startRun(w, 32, `${S}/x2`, 'run', line({ step: 1, status: 'running', remark: 'Step 1' }), '/work/other-project')
    await w.clock.advance(1500)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /idle/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /running/ })).toBeUndefined()
    await band.unmount()
  })

  test('the last result from an earlier session shows, beside v1’s own history in the same store', async ($, on) => {
    // v1 of this plugin keeps a list under `history` in the same store; v2 keeps its own record.
    const w = world(on, { store: { history: [{ id: 'v1-run', status: 'passed' }], recentByProject: { [PROJECT]: [{ label: 'login_test.md', status: 'passed', at: T0 - 7_200_000 }] } } })
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /login · 2h ago/ })).toBeDefined()
    await band.unmount()
  })

  test('a stream with unknown events or a newer wire version never throws', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    startRun(w, 41, `${S}/n1`, 'run', 'not json\n' + line({ type: 'brand_new', x: 1 }) + `${JSON.stringify({ type: 'stream_start', v: 2, ts: at(0) })}\n` + '{"half":')
    await w.clock.advance(1500)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /newer than the mod/ })).toBeDefined()
    await band.unmount()
  })
})

describe('after Claude changes code', () => {
  async function edit($: { tool: { call: (i: never) => Promise<unknown> } }, path: string) {
    await $.tool.call({ tool: 'Write', file_path: path, content: 'x' } as never)
  }

  test('offer: a turn ending with an edit raises the warning; the card drafts an objective and hands it to Claude; a later run clears it', async ($, on) => {
    const w = world(on, { forkText: 'Objective: Type a postcode with a space and check the order is placed.' })
    w.files[`${PROJECT}/.testmuai/tests/checkout_guest_test.md`] = 'Open https://shop.test/ and fill the shipping address as a guest'
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await edit($, `${PROJECT}/src/checkout/AddressForm.tsx`)
    await edit($, `${PROJECT}/README.md`)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /changed, untested/ })).toBeUndefined()
    await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' } as never)
    expect(await band.find({ type: 'Text', text: /1 file changed, untested/ })).toBeDefined()
    await band.press({ key: 'test' })
    await w.clock.settle()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    // A saved test covers it: offered first, no draft until asked.
    expect(await pane.find({ type: 'Text', text: /^checkout_guest$/ })).toBeDefined()
    expect(await pane.find({ key: 'saved-run-checkout_guest_test.md' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Suggested objective/ })).toBeUndefined()
    await pane.press({ key: 'offer-draft' })
    await w.clock.settle()
    expect(await pane.find({ type: 'Text', text: /Type a postcode with a space/ })).toBeDefined()
    await pane.press({ key: 'offer-run' })
    expect(w.prompts.at(-1)).toContain('kane-cli run "Type a postcode with a space and check the order is placed." --url https://shop.test/ --agent --headless')

    // Claude runs it; the run ends: the warning is gone.
    await w.clock.advance(5000)
    startRun(w, 61, `${S}/c1`, 'run', line({ step: 1, status: 'done', remark: 'Typed the postcode' }, 6) + line({ type: 'run_end', status: 'passed' }, 7))
    w.files[`${ACTIVE}/61.json`] = JSON.stringify({ pid: 61, cwd: PROJECT, surface: 'run', session_dir: `${S}/c1`, started: at(6) })
    await w.clock.advance(1500)
    await w.clock.settle()
    expect(await band.find({ type: 'Text', text: /changed, untested/ })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /✓ 1 passed/ })).toBeDefined()
    await pane.unmount()
    await band.unmount()
  })

  test('an edit made from the shell counts too: Bash reports the files it changed', async ($, on) => {
    const w = world(on, { bashResult: { stdout: '', bashEditDiff: { files: [], moreFiles: 0, changedFiles: [`${PROJECT}/src/cart.ts`] } } })
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await $.tool.call({ tool: 'Bash', command: "printf 'x' > src/cart.ts" } as never)
    await w.clock.settle()
    await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' } as never)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /1 file changed, untested/ })).toBeDefined()
    await band.unmount()
  })

  test('files other tools write while a kane-cli run goes are not Claude’s edits', async ($, on) => {
    const w = world(on, { bashResult: { stdout: '', bashEditDiff: { files: [], moreFiles: 0, changedFiles: [`${PROJECT}/src/cart.ts`] } } })
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await $.tool.call({ tool: 'Bash', command: 'kane-cli run "Add an iPod to the cart" --agent --headless' } as never)
    await w.clock.settle()
    await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' } as never)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /changed, untested/ })).toBeUndefined()
    await band.unmount()
  })

  test('auto: Claude is held once to test the change, never twice', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await $.command.run({ command: 'kane', args: 'auto' } as never)
    await edit($, `${PROJECT}/src/cart.ts`)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /Claude will test this before it finishes/ })).toBeDefined()
    const first = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' } as never)
    expect(String((first as { block?: string }).block)).toContain('src/cart.ts')
    const again = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' } as never)
    expect((again as { block?: string }).block).toBeUndefined()
    // Claude finished without testing: the band stops promising and offers the test.
    expect(await band.find({ type: 'Text', text: /Claude will test this/ })).toBeUndefined()
    expect(await band.find({ key: 'test' })).toBeDefined()
    await band.unmount()
  })

  test('off: the band never mentions the change; ignored files never count', async ($, on) => {
    const w = world(on, { ignored: new Set([`${PROJECT}/dist/app.js`]) })
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await edit($, `${PROJECT}/dist/app.js`)
    await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' } as never)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /changed, untested/ })).toBeUndefined()
    await $.command.run({ command: 'kane', args: 'off' } as never)
    await edit($, `${PROJECT}/src/cart.ts`)
    const r = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'done' } as never)
    expect((r as { block?: string }).block).toBeUndefined()
    expect(await band.find({ type: 'Text', text: /changed, untested/ })).toBeUndefined()
    await band.unmount()
  })
})

describe('assurance', () => {
  test('a project with a requirement store shows proven coverage in the band and use cases in the pane', async ($, on) => {
    const w = world(on, {
      cover: JSON.stringify({
        design_completeness: { pct: 82 },
        proven: { pct: 47, failing: 2, blocked: 1, latest_run: { started_at: at(-7200) } },
        usecases: [{ id: 'uc-buy-as-a-guest', design_completeness: { pct: 75 }, proven: { pct: 38 }, stale_acs: 1, pending: [{ stage: 'cover' }] }],
      }),
    })
    w.files[`${PROJECT}/.context/commits/1`] = 'x'
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await w.clock.settle()
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await band.find({ type: 'Text', text: /47%/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /proven · 1 use case/ })).toBeDefined()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    await pane.press({ key: 'tab-assure' })
    expect(await pane.find({ key: 'uc-uc-buy-as-a-guest' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /2 failing · 1 blocked · run 2h ago/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /1 stale/ })).toBeDefined()
    await pane.unmount()
    await band.unmount()
  })

  test('a use case opens to what it still owes; its gaps are handed to Claude, never run by the mod', async ($, on) => {
    const w = world(on, {
      cover: JSON.stringify({
        design_completeness: { pct: 82 },
        proven: { pct: 47 },
        usecases: [
          {
            id: 'uc-buy-as-a-guest',
            title: 'Buy as a guest',
            risk: 'high',
            design_completeness: { pct: 75 },
            proven: { pct: 38 },
            stale_acs: 0,
            pending: [
              { stage: 'design', title: 'Declined card shows a message', why: 'no test verifies this AC', risk: 'high', ready_command: 'kane-cli design tests --use-case uc-buy-as-a-guest' },
              { stage: 'cover', title: 'Guest email is required', why: 'covered, never run', ready_command: 'kane-cli testrun run' },
            ],
          },
          { id: 'uc-mobile-sign-in', design_completeness: { pct: 100 }, proven: { pct: 100 }, stale_acs: 0, pending: [] },
        ],
      }),
    })
    w.files[`${PROJECT}/.context/commits/1`] = 'x'
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await w.clock.settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ ...PANE, surface } as never)
      await pane.press({ key: 'tab-assure' })
      // The list names each use case, not only its id.
      expect(await pane.find({ type: 'Text', text: /^Buy as a guest$/ })).toBeDefined()
      await pane.press({ key: 'uc-uc-buy-as-a-guest' })
      expect(await pane.find({ type: 'Text', text: /^Buy as a guest$/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /^high risk$/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /^To design$/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /Declined card shows a message/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /no test verifies this AC/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /kane-cli design tests --use-case uc-buy-as-a-guest/ })).toBeDefined()
      expect(await pane.find({ type: 'Text', text: /^To run$/ })).toBeDefined()
      expect(await pane.find({ key: 'uc-uc-mobile-sign-in' })).toBeUndefined()
      await pane.press({ key: 'uc-back' })
      await pane.press({ key: 'uc-uc-mobile-sign-in' })
      expect(await pane.find({ type: 'Text', text: /Nothing owed/ })).toBeDefined()
      expect(await pane.find({ key: 'uc-close' })).toBeUndefined()
      // Leaving the tab closes the use case.
      await pane.press({ key: 'tab-runs' })
      await pane.press({ key: 'tab-assure' })
      expect(await pane.find({ key: 'uc-uc-buy-as-a-guest' })).toBeDefined()
      await pane.unmount()
    }
    expect(w.prompts).toEqual([])
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    await pane.press({ key: 'uc-uc-buy-as-a-guest' })
    await pane.press({ key: 'uc-close' })
    expect(w.prompts.length).toBe(1)
    expect(w.prompts[0]).toContain('kane-cli cover gaps uc-buy-as-a-guest')
    expect(w.prompts[0]).toContain('kane-cli design tests --use-case uc-buy-as-a-guest')
    await pane.unmount()
  })
})

describe('a use case whose gaps share one reason', () => {
  test('says the reason and the next command once, under the list', async ($, on) => {
    const row = (title: string) => ({ stage: 'cover', title, why: 'a covering test exists but has not run yet', ready_command: 'kane-cli testrun run' })
    const w = world(on, {
      cover: JSON.stringify({ design_completeness: { pct: 100 }, proven: { pct: 50 }, usecases: [{ id: 'uc-1', title: 'Buy as a guest', risk: 'high', design_completeness: { pct: 100 }, proven: { pct: 50 }, stale_acs: 0, pending: [row('A placed order displays an order number.'), row('A placed order empties the cart.')] }] }),
    })
    w.files[`${PROJECT}/.context/commits/1`] = 'x'
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await w.clock.settle()
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    await pane.press({ key: 'tab-assure' })
    await pane.press({ key: 'uc-uc-1' })
    expect(await pane.find({ type: 'Text', text: /A placed order empties the cart/ })).toBeDefined()
    expect((await pane.findAll({ type: 'Text', text: /^a covering test exists but has not run yet$/ })).length).toBe(1)
    expect((await pane.findAll({ type: 'Text', text: /^kane-cli testrun run$/ })).length).toBe(1)
    await pane.unmount()
  })
})

describe('the card in the chat', () => {
  const CMD = 'kane-cli testmd run .testmuai/tests/checkout_guest_test.md --agent --headless'
  const row = (component: 'ToolUse' | 'ToolResult', id: string, command: string, more: object = {}) => ({
    plugin: 'kane-qe',
    component,
    requestId: id,
    props: component === 'ToolUse' ? { tool_use_id: id, tool: 'Bash', input: { command }, isRunning: false, isErrored: false, isInterrupted: false } : { tool_use_id: id, tool: 'Bash', output: { stdout: 'raw kane-cli output', stderr: '' }, isErrored: false },
    ...more,
  })
  const FULL = { viewport: { columns: 100, rows: 40, isFullscreen: true } }

  /** Claude runs a test file; kane-cli starts it. */
  async function begin($: { session: { start: (a: never) => Promise<unknown> }; tool: { call: (a: never) => Promise<unknown> } }, w: World, id = 'toolu_1') {
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await $.tool.call({ tool: 'Bash', command: CMD, tool_use_id: id } as never)
    const dir = `${S}/card-1`
    startRun(w, 71, dir, 'testmd', line({ type: 'stream_start', surface: 'testmd', pid: 71 }) + line({ type: 'test_md_step_start', step_index: 1, heading: 'Fill the shipping address' }, 2))
    return dir
  }
  const fail = (w: World, dir: string) => {
    w.files[`${dir}/events.ndjson`] +=
      line({ type: 'run_end', status: 'failed', credits_consumed: 31.2, verdict: { root_cause: 'Postcode field rejects valid input', category: 'functional_defect', severity: 'high', confidence: 0.86 } }, 60) +
      line({ type: 'test_md_step_end', step_index: 1, status: 'failed', duration_s: 58 }, 60) +
      line({ type: 'test_md_done', overall_status: 'failed', duration_s: 66 }, 66)
    w.files[`${dir}/evidence/8f0e.evidence`] = 'pack'
    endRun(w, 71)
  }

  test('a run Claude started is one line while it runs, then a card with its result, its steps and its evidence', async ($, on) => {
    const w = world(on, { viewer: 'https://viewer.example/?pack=p' })
    const dir = await begin($, w)
    await w.clock.advance(1500)
    await w.clock.settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const live = await $.ui.mount({ ...row('ToolUse', 'toolu_1', CMD, FULL), surface } as never)
      // A spinner leads the line: a cell repainted in place on a terminal, a glyph elsewhere.
      if (surface === 'terminal') expect(await live.find({ type: 'Raster', key: 'spin' })).toBeDefined()
      else expect(await live.find({ type: 'Text', text: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/ })).toBeDefined()
      const band = await $.ui.mount({ ...BAND, surface } as never)
      if (surface === 'terminal') expect(await band.find({ type: 'Raster', key: 'spin' })).toBeDefined()
      else expect(await band.find({ type: 'Text', text: /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/ })).toBeDefined()
      await band.unmount()
      expect(await live.find({ type: 'Text', text: /^checkout_guest$/ })).toBeDefined()
      expect(await live.find({ type: 'Text', text: /Fill the shipping address/ })).toBeDefined()
      expect(await live.find({ key: 'card-evidence' })).toBeUndefined()
      await live.unmount()
    }
    // While it runs, kane-cli's own output still shows.
    const before = await $.ui.mount({ ...row('ToolResult', 'toolu_1', CMD, FULL), surface: 'terminal' } as never)
    expect(await before.find({ type: 'Text', text: /engine ToolResult/ })).toBeDefined()
    await before.unmount()

    fail(w, dir)
    await w.clock.advance(1500)
    await w.clock.settle()
    for (const surface of ['terminal', 'desktop'] as const) {
      const card = await $.ui.mount({ ...row('ToolUse', 'toolu_1', CMD, FULL), surface } as never)
      expect(await card.find({ type: 'Text', text: /^✗ failed$/ })).toBeDefined()
      expect(await card.find({ type: 'Text', text: /^31\.2 credits$/ })).toBeDefined()
      expect(await card.find({ type: 'Text', text: /^Postcode field rejects valid input$/ })).toBeDefined()
      expect(await card.find({ type: 'Text', text: /^functional defect · high · 86% sure$/ })).toBeDefined()
      expect(await card.find({ type: surface === 'terminal' ? 'Raster' : 'Svg' })).toBeDefined()
      expect(await card.find({ key: 'card-steps' })).toBeDefined()
      expect(await card.find({ key: 'card-evidence' })).toBeDefined()
      await card.unmount()
    }
    // The card stands for the call: its raw output is gone.
    const after = await $.ui.mount({ ...row('ToolResult', 'toolu_1', CMD, FULL), surface: 'terminal' } as never)
    expect(await after.find({ type: 'Text', text: /engine ToolResult/ })).toBeUndefined()
    await after.unmount()

    // Once it has ended nothing spins: not the card, not the band.
    const idle = await $.ui.mount({ ...BAND, surface: 'terminal' } as never)
    expect(await idle.find({ key: 'spin' })).toBeUndefined()
    await idle.unmount()
    const card = await $.ui.mount({ ...row('ToolUse', 'toolu_1', CMD, FULL), surface: 'terminal' } as never)
    expect(await card.find({ key: 'spin' })).toBeUndefined()
    await card.press({ key: 'card-evidence' })
    await w.clock.settle()
    expect(w.ran.some(a => a.join(' ') === `kane-cli evidence serve ${dir}/evidence/8f0e.evidence`)).toBe(true)
    expect(w.ran.some(a => a[0] === 'open' && a[1] === 'https://viewer.example/?pack=p')).toBe(true)
    expect(w.prompts).toEqual([])
    // A second press reuses the viewer that is already serving.
    await card.press({ key: 'card-evidence' })
    await w.clock.settle()
    expect(w.ran.filter(a => a.includes('serve')).length).toBe(1)
    expect(w.ran.filter(a => a[0] === 'open').length).toBe(2)
    await card.press({ key: 'card-steps' })
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
    expect(await pane.find({ type: 'Text', text: /^where$/ })).toBeDefined()
    await pane.unmount()
    await card.unmount()
  })

  test('where the chat is printed text, the card ends with the evidence path, not buttons', async ($, on) => {
    const w = world(on)
    const dir = await begin($, w)
    await w.clock.advance(1500)
    await w.clock.settle()
    fail(w, dir)
    await w.clock.advance(1500)
    await w.clock.settle()
    const card = await $.ui.mount({ ...row('ToolUse', 'toolu_1', CMD, { viewport: { columns: 100, rows: 40, isFullscreen: false } }), surface: 'terminal' } as never)
    expect(await card.find({ type: 'Text', text: /^✗ failed$/ })).toBeDefined()
    expect(await card.find({ key: 'card-evidence' })).toBeUndefined()
    expect(await card.find({ key: 'card-steps' })).toBeUndefined()
    expect(await card.find({ type: 'Text', text: new RegExp(`^${dir}/evidence/8f0e\\.evidence$`) })).toBeDefined()
    await card.unmount()
  })

  test('with no viewer to start, View evidence asks Claude instead', async ($, on) => {
    const w = world(on)
    const dir = await begin($, w)
    await w.clock.advance(1500)
    await w.clock.settle()
    fail(w, dir)
    await w.clock.advance(1500)
    await w.clock.settle()
    const card = await $.ui.mount({ ...row('ToolUse', 'toolu_1', CMD, FULL), surface: 'terminal' } as never)
    await card.press({ key: 'card-evidence' })
    await w.clock.settle()
    expect(w.ran.some(a => a[0] === 'open')).toBe(false)
    expect(w.prompts[0]).toContain(`${dir}/evidence/8f0e.evidence`)
    await card.unmount()
  })

  test('other rows keep the engine’s drawing: another command, a kane-cli command that is no run, a run that never started', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    await $.tool.call({ tool: 'Bash', command: CMD, tool_use_id: 'toolu_9' } as never)
    await w.clock.advance(1500)
    await w.clock.settle()
    const cases = [
      { name: 'another command', id: 'toolu_2', command: 'npm test' },
      { name: 'a read-only kane-cli command', id: 'toolu_3', command: 'kane-cli cover gaps --json' },
      { name: 'a run kane-cli never started', id: 'toolu_9', command: CMD },
    ]
    for (const c of cases) {
      for (const component of ['ToolUse', 'ToolResult'] as const) {
        const r = await $.ui.mount({ ...row(component, c.id, c.command, FULL), surface: 'terminal' } as never)
        expect(await r.find({ type: 'Text', text: new RegExp(`engine ${component}`) })).toBeDefined()
        await r.unmount()
      }
    }
  })

  test('a folded group of shell calls is unfolded only when it holds a kane-cli run', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    const group = (commands: string[]) => ({
      plugin: 'kane-qe',
      component: 'ToolGroup',
      requestId: 'g1',
      surface: 'terminal',
      props: { calls: commands.map((command, i) => ({ tool_use_id: `t${i}`, tool: 'Bash', input: { command }, isRunning: false, isErrored: false })), isActive: false, isExpanded: false },
    })
    const cases = [
      { commands: ['ls', 'git status'], want: false },
      { commands: ['kane-cli whoami'], want: false },
      { commands: ['ls', CMD], want: true },
      { commands: ['kane-cli run "Search for iPod" --agent'], want: true },
    ]
    for (const c of cases) {
      w.rows.length = 0
      const g = await $.ui.mount(group(c.commands) as never)
      expect(w.rows.find(r => r.component === 'ToolGroup')?.isExpanded).toBe(c.want)
      await g.unmount()
    }
  })

  test('a suite’s card counts its tests and names its failures; its pack is the one its execution id names', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJECT, surface: 'terminal', isInteractive: true } as never)
    const cmd = 'kane-cli testrun run --tags smoke --agent'
    await $.tool.call({ tool: 'Bash', command: cmd, tool_use_id: 'toolu_s' } as never)
    const a = `${PROJECT}/.testmuai/tests/login_test.md`
    const b = `${PROJECT}/.testmuai/tests/checkout_guest_test.md`
    startRun(
      w,
      81,
      `${S}/testrun-ex1`,
      'testrun',
      line({ type: 'stream_start', surface: 'testrun', pid: 81 }) +
        line({ type: 'testrun_plan', members: [{ path: a }, { path: b }], parallel: 2 }) +
        line({ type: 'testrun_member_start', path: a }, 1) +
        line({ type: 'testrun_member_end', path: a, status: 'passed', duration_s: 20 }, 21) +
        line({ type: 'testrun_member_start', path: b }, 1) +
        line({ type: 'testrun_member_end', path: b, status: 'failed', duration_s: 30, failure: { message: 'Postcode field rejects valid input' } }, 31) +
        line({ type: 'testrun_done', execution_id: 'ex1', overall_status: 'failed' }, 40),
    )
    w.files[`${PROJECT}/.testmuai/evidence/ex1.evidence`] = 'pack'
    await w.clock.advance(1500)
    await w.clock.settle()
    endRun(w, 81)
    await w.clock.advance(1500)
    await w.clock.settle()
    const card = await $.ui.mount({ ...row('ToolUse', 'toolu_s', cmd, FULL), surface: 'terminal' } as never)
    expect(await card.find({ type: 'Text', text: /^suite · --tags smoke$/ })).toBeDefined()
    expect(await card.find({ type: 'Text', text: /^1 passed$/ })).toBeDefined()
    expect(await card.find({ type: 'Text', text: /^1 failed$/ })).toBeDefined()
    expect(await card.find({ type: 'Text', text: /^✗ checkout_guest$/ })).toBeDefined()
    expect(await card.find({ type: 'Button', text: /View tests/ }) ?? (await card.find({ key: 'card-steps' }))).toBeDefined()
    expect(await card.find({ key: 'card-evidence' })).toBeDefined()
    await card.unmount()
  })
})
